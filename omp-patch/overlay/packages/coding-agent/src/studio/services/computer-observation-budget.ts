import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

export const COMPUTER_OBSERVATION_RESERVATION_BYTES = 8 * 1024 * 1024;
const PROFILE_BUDGET = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
interface Reservation {
	frameId: string;
	scopeSessionId: string;
	sessionId: string;
	bytes: number;
	expiresAt: number;
}
const hash = (id: string): string => createHash("sha256").update(id).digest("hex");
const missing = (error: unknown): void => {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
};

/** Cross-Runtime stage reservations. The OS-backed lock covers small metadata and unlinks, never capture or PNG writes. */
export class ComputerObservationBudget {
	readonly #file: string;
	constructor(
		readonly directory: string,
		readonly now: () => number = Date.now,
	) {
		this.#file = path.join(directory, "computer-workspace", "observation-budget.json");
	}
	#descriptor(row: Reservation): string {
		return path.join(this.directory, "computer-workspace", hash(row.scopeSessionId), `${row.frameId}.json`);
	}
	async #promoted(row: Reservation): Promise<boolean> {
		try {
			const sidecar = (await Bun.file(this.#descriptor(row).replace(/\.json$/u, ".artifact.json")).json()) as {
				frameId?: string;
				scopeSessionId?: string;
				artifactId?: string;
				kept?: boolean;
			};
			return (
				sidecar.frameId === row.frameId &&
				sidecar.scopeSessionId === row.scopeSessionId &&
				(sidecar.kept === true || typeof sidecar.artifactId === "string")
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	async #removeExpired(row: Reservation): Promise<void> {
		if (await this.#promoted(row)) return;
		// Only the exact observation copy registered by the producer may be collected.
		try {
			const descriptor = (await Bun.file(this.#descriptor(row)).json()) as {
				version?: number;
				scopeSessionId?: string;
				frame?: { frameId?: string; sessionId?: string; source?: string };
			};
			if (
				descriptor.version !== 1 ||
				descriptor.scopeSessionId !== row.scopeSessionId ||
				descriptor.frame?.frameId !== row.frameId ||
				descriptor.frame.sessionId !== row.sessionId ||
				descriptor.frame.source !== "observation"
			)
				throw new Error("Observation reservation descriptor changed");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (await this.#promoted(row)) return;
		await fs.unlink(this.#descriptor(row)).catch(missing);
		const outputDirectory = path.join(this.directory, "outputs", hash(row.sessionId));
		await fs.unlink(path.join(outputDirectory, `${row.frameId}.bin`)).catch(missing);
		// An interrupted atomic byte write is owned by the same UUID reservation.
		const names = await fs.readdir(outputDirectory).catch(error => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const name of names)
			if (name.startsWith(`${row.frameId}.bin.`) && name.endsWith(".partial"))
				await fs.unlink(path.join(outputDirectory, name)).catch(missing);
		const descriptorDirectory = path.dirname(this.#descriptor(row));
		const metadata = await fs.readdir(descriptorDirectory).catch(error => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const name of metadata)
			if (name.startsWith(`${row.frameId}.json.`) && name.endsWith(".partial"))
				await fs.unlink(path.join(descriptorDirectory, name)).catch(missing);
	}
	async #edit<T>(change: (rows: Reservation[]) => T | Promise<T>): Promise<T> {
		await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		return withFileLock(
			this.#file,
			async () => {
				let rows: Reservation[];
				try {
					const stat = await fs.lstat(this.#file);
					if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
						throw new Error("Observation budget metadata unavailable");
					const value = (await Bun.file(this.#file).json()) as { version: number; reservations: Reservation[] };
					if (value.version !== 1 || !Array.isArray(value.reservations) || value.reservations.length > 4096)
						throw new Error("Observation budget metadata unavailable");
					rows = value.reservations;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					rows = [];
				}
				const retained: Reservation[] = [];
				for (const row of rows) {
					if (
						!UUID.test(row.frameId) ||
						typeof row.scopeSessionId !== "string" ||
						typeof row.sessionId !== "string" ||
						!Number.isSafeInteger(row.bytes) ||
						row.bytes < 0 ||
						!Number.isFinite(row.expiresAt)
					)
						throw new Error("Observation budget metadata is corrupt");
					if (await this.#promoted(row)) continue;
					if (row.expiresAt <= this.now()) await this.#removeExpired(row);
					else retained.push(row);
				}
				const result = await change(retained);
				const temporary = `${this.#file}.${crypto.randomUUID()}.partial`;
				try {
					const file = await fs.open(temporary, "wx", 0o600);
					try {
						await file.writeFile(JSON.stringify({ version: 1, reservations: retained }));
						await file.sync();
					} finally {
						await file.close();
					}
					await fs.rename(temporary, this.#file);
				} finally {
					await fs.unlink(temporary).catch(missing);
				}
				return result;
			},
			{ retries: 100, retryDelayMs: 20 },
		);
	}
	reserve(frameId: string, scopeSessionId: string, sessionId: string, expiresAt: number): Promise<void> {
		if (!UUID.test(frameId)) throw new Error("Invalid observation reservation identity");
		return this.#edit(rows => {
			if (rows.some(row => row.frameId === frameId)) throw new Error("Observation reservation already exists");
			if (
				rows.length >= 4096 ||
				rows.reduce((sum, row) => sum + row.bytes, 0) + COMPUTER_OBSERVATION_RESERVATION_BYTES > PROFILE_BUDGET
			)
				throw new Error("The profile's 64 MiB observation stage is full; close a view or retry after expiration");
			rows.push({ frameId, scopeSessionId, sessionId, bytes: COMPUTER_OBSERVATION_RESERVATION_BYTES, expiresAt });
		});
	}
	commit(frameId: string, bytes: number, expiresAt: number): Promise<void> {
		return this.#edit(rows => {
			const row = rows.find(row => row.frameId === frameId);
			if (!row || bytes > row.bytes || bytes < 0)
				throw new Error("Observation reservation expired or capture exceeds its budget");
			row.bytes = bytes;
			row.expiresAt = expiresAt;
		});
	}
	release(frameId: string): Promise<void> {
		return this.#edit(rows => {
			const index = rows.findIndex(row => row.frameId === frameId);
			if (index >= 0) rows.splice(index, 1);
		});
	}
	cancel(frameId: string): Promise<void> {
		return this.#edit(async rows => {
			const index = rows.findIndex(row => row.frameId === frameId);
			if (index < 0) return;
			await this.#removeExpired(rows[index]);
			rows.splice(index, 1);
		});
	}
	reap(): Promise<void> {
		return this.#edit(() => {});
	}
}
