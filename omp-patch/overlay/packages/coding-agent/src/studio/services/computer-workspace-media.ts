import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ComputerFrame } from "../computer-workspace-protocol";
import { StudioMediaFiles } from "./media-files";
import { ComputerObservationBudget } from "./computer-observation-budget";

export interface ComputerFrameDescriptor {
	version: 1;
	scopeSessionId: string;
	frame: ComputerFrame;
	bytes: number;
	sha256: string;
	leaseId?: string;
	runFinished?: boolean;
}
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ignoreMissing = (error: unknown): void => {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
};

/** Only owned descriptors and managed copies; the native source image is never removed. */
export class ComputerWorkspaceMedia {
	readonly #files: StudioMediaFiles;
	readonly #budget: ComputerObservationBudget;
	readonly #updates = new Map<string, Promise<void>>();
	constructor(
		readonly directory: string,
		readonly scopeSessionId: string,
		readonly owns: (sessionId: string) => boolean,
		now: () => number = Date.now,
	) {
		this.#files = new StudioMediaFiles(directory);
		this.#budget = new ComputerObservationBudget(directory, now);
	}
	#descriptor(frameId: string): string {
		if (!uuid.test(frameId)) throw new Error("Invalid computer frame identity");
		return path.join(this.directory, "computer-workspace", hash(this.scopeSessionId), `${frameId}.json`);
	}
	#output(frame: ComputerFrame): string {
		return path.join(this.directory, "outputs", hash(frame.sessionId), `${frame.frameId}.bin`);
	}
	async #atomic(file: string, value: string | Uint8Array): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const partial = `${file}.${crypto.randomUUID()}.partial`;
		try {
			const handle = await fs.open(partial, "wx", 0o600);
			try {
				await handle.writeFile(value);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(partial, file);
		} finally {
			await fs.unlink(partial).catch(ignoreMissing);
		}
	}
	reserveObservation(frameId: string, sessionId: string, expiresAt: number): Promise<void> {
		if (!this.owns(sessionId)) throw new Error("Observation scope changed");
		return this.#budget.reserve(frameId, this.scopeSessionId, sessionId, expiresAt);
	}
	releaseObservationReservation(frameId: string): Promise<void> {
		return this.#budget.cancel(frameId);
	}
	async save(
		frame: ComputerFrame,
		bytes: Uint8Array,
		valid: () => boolean,
		leaseId?: string,
	): Promise<ComputerFrameDescriptor> {
		if (!this.owns(frame.sessionId) || !valid()) throw new Error("Computer frame scope changed");
		if (
			bytes.byteLength > 16 * 1024 * 1024 ||
			bytes.byteLength < 8 ||
			bytes[0] !== 137 ||
			bytes[1] !== 80 ||
			bytes[2] !== 78 ||
			bytes[3] !== 71
		)
			throw new Error("Computer frame exceeds the PNG budget");
		await this.#files.assertSession(frame.sessionId);
		const descriptor: ComputerFrameDescriptor = {
			version: 1,
			scopeSessionId: this.scopeSessionId,
			frame: { ...frame },
			bytes: bytes.byteLength,
			sha256: hash(bytes),
			...(leaseId ? { leaseId } : {}),
		};
		try {
			// A pending atomic descriptor is the crash journal for this owned output/job pair.
			await this.#atomic(
				this.#descriptor(frame.frameId),
				JSON.stringify({ ...descriptor, frame: { ...frame, availability: "pending" } }),
			);
			await this.#atomic(this.#output(frame), bytes);
			if (frame.source === "execution")
				await this.#files.saveJob(frame.sessionId, frame.frameId, {
					job: { id: frame.frameId, sessionId: frame.sessionId },
					outputs: [
						{
							artifactId: frame.frameId,
							kind: "image",
							name: `computer-${frame.frameId}.png`,
							mimeType: "image/png",
							bytes: descriptor.bytes,
							sha256: descriptor.sha256,
						},
					],
				});
			if (frame.source === "observation")
				await this.#budget.commit(frame.frameId, bytes.byteLength, frame.expiresAt!);
			await this.#atomic(this.#descriptor(frame.frameId), JSON.stringify(descriptor));
			await this.#files.assertSession(frame.sessionId);
			if (!valid() || !this.owns(frame.sessionId))
				throw new Error("Computer frame scope changed during persistence");
			return descriptor;
		} catch (error) {
			await this.remove(frame, false);
			throw error;
		}
	}
	async update(frame: ComputerFrame, runFinished?: boolean): Promise<void> {
		const prior = this.#updates.get(frame.frameId) ?? Promise.resolve();
		const next = prior
			.catch(() => {})
			.then(async () => {
				const descriptor = await this.read(frame.frameId);
				if (descriptor && !(await this.expired(frame.frameId)))
					await this.#atomic(
						this.#descriptor(frame.frameId),
						JSON.stringify({
							...descriptor,
							frame: { ...frame, delivered: frame.delivered || descriptor.frame.delivered },
							...(runFinished === undefined ? {} : { runFinished }),
						}),
					);
			});
		this.#updates.set(frame.frameId, next);
		try {
			await next;
		} finally {
			if (this.#updates.get(frame.frameId) === next) this.#updates.delete(frame.frameId);
		}
	}
	async read(frameId: string): Promise<ComputerFrameDescriptor | undefined> {
		try {
			const file = this.#descriptor(frameId);
			const stat = await fs.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) return undefined;
			const value = (await Bun.file(file).json()) as ComputerFrameDescriptor;
			if (
				value.version !== 1 ||
				value.scopeSessionId !== this.scopeSessionId ||
				value.frame.frameId !== frameId ||
				!this.owns(value.frame.sessionId)
			)
				return undefined;
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async expired(frameId: string): Promise<boolean> {
		try {
			const sidecar = (await Bun.file(this.#descriptor(frameId).replace(/\.json$/u, ".artifact.json")).json()) as {
				expired?: boolean;
				frameId?: string;
				scopeSessionId?: string;
			};
			return (
				sidecar.expired === true && sidecar.frameId === frameId && sidecar.scopeSessionId === this.scopeSessionId
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	async kept(frameId: string): Promise<boolean> {
		try {
			const sidecar = (await Bun.file(this.#descriptor(frameId).replace(/\.json$/u, ".artifact.json")).json()) as {
				kept?: boolean;
				frameId?: string;
				scopeSessionId?: string;
			};
			return sidecar.kept === true && sidecar.frameId === frameId && sidecar.scopeSessionId === this.scopeSessionId;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	async remove(frame: ComputerFrame, respectKept = true): Promise<void> {
		if (respectKept && (await this.kept(frame.frameId))) {
			if (frame.source === "observation") await this.#budget.release(frame.frameId);
			return;
		}
		await fs.unlink(this.#descriptor(frame.frameId)).catch(ignoreMissing);
		await fs.unlink(this.#output(frame)).catch(ignoreMissing);
		if (frame.source === "execution")
			await fs
				.unlink(path.join(this.directory, "jobs", hash(frame.sessionId), `${frame.frameId}.json`))
				.catch(ignoreMissing);
		if (frame.source === "observation") await this.#budget.release(frame.frameId);
	}
	async cleanup(now: number): Promise<void> {
		await this.#budget.reap();
		const directory = path.dirname(this.#descriptor("00000000-0000-0000-0000-000000000000"));
		const names = await fs.readdir(directory).catch(error => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const name of names) {
			if (name.endsWith(".partial")) {
				await fs.unlink(path.join(directory, name)).catch(ignoreMissing);
				continue;
			}
			if (!uuid.test(name.slice(0, -5)) || !name.endsWith(".json")) continue;
			const value = await this.read(name.slice(0, -5));
			if (!value) continue;
			if (
				value.frame.availability === "pending" ||
				value.frame.source === "observation" ||
				(value.frame.expiresAt ?? Infinity) <= now
			)
				await this.remove(value.frame);
		}
	}
}
