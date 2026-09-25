import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface StudioMediaAsset {
	artifactId: string;
	kind: "image" | "audio" | "video" | "transcript";
	name: string;
	mimeType: string;
	bytes: number;
	sha256: string;
}
const checkedId = (id: string) => {
	if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid media identifier");
	return id;
};
/** Current-user-only directory set by the Desktop launcher; paths never cross the public contract. */
export class StudioMediaFiles {
	constructor(readonly directory: string) {
		if (!isAbsolute(directory)) throw new Error("Private media directory must be absolute");
	}
	async assertSession(sessionId: string): Promise<void> {
		const fence = join(
			this.directory,
			"deleted-sessions",
			createHash("sha256").update(sessionId).digest("hex") + ".json",
		);
		const exists = await lstat(fence).catch(error => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (exists) throw new Error("The media session was deleted");
	}
	async releaseInputs(ids: Iterable<string>): Promise<void> {
		await Promise.all(
			[...ids].flatMap(id =>
				[".bin", ".json"].map(extension =>
					unlink(join(this.directory, "inputs", checkedId(id) + extension)).catch(() => {}),
				),
			),
		);
	}
	async input(id: string, kind?: StudioMediaAsset["kind"]): Promise<{ bytes: Uint8Array; meta: StudioMediaAsset }> {
		checkedId(id);
		const metaFile = join(this.directory, "inputs", id + ".json");
		const file = join(this.directory, "inputs", id + ".bin");
		const metadata = await lstat(metaFile);
		const stat = await lstat(file);
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size > 4096 ||
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.size > 64 * 1024 * 1024
		)
			throw new Error("Media input unavailable");
		const meta = JSON.parse(await readFile(metaFile, "utf8")) as StudioMediaAsset;
		if (meta.artifactId !== id || (kind && meta.kind !== kind) || meta.bytes !== stat.size)
			throw new Error("Media input metadata changed");
		const bytes = await readFile(file);
		if (bytes.length !== meta.bytes || createHash("sha256").update(bytes).digest("hex") !== meta.sha256)
			throw new Error("Media input integrity check failed");
		await Promise.all([unlink(metaFile), unlink(file)]);
		return { bytes, meta };
	}
	async output(
		meta: Pick<StudioMediaAsset, "name" | "kind" | "mimeType">,
		source: AsyncIterable<Uint8Array>,
		sessionId: string,
	): Promise<StudioMediaAsset> {
		await this.assertSession(sessionId);
		const artifactId = randomUUID();
		const dir = join(this.directory, "outputs", createHash("sha256").update(sessionId).digest("hex"));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const target = join(dir, artifactId + ".bin");
		const temporary = target + ".partial";
		const hash = createHash("sha256");
		let bytes = 0;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				for await (const chunk of source) {
					bytes += chunk.length;
					if (bytes > 512 * 1024 * 1024) throw new Error("Media output exceeds 512 MiB");
					hash.update(chunk);
					await file.writeFile(chunk);
				}
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, target);
			try {
				await this.assertSession(sessionId);
			} catch (error) {
				await unlink(target).catch(() => {});
				throw error;
			}
			return { ...meta, artifactId, bytes, sha256: hash.digest("hex") };
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}
	outputBytes(
		meta: Pick<StudioMediaAsset, "name" | "kind" | "mimeType">,
		bytes: Uint8Array,
		sessionId: string,
	): Promise<StudioMediaAsset> {
		return this.output(
			meta,
			(async function* () {
				yield bytes;
			})(),
			sessionId,
		);
	}
	async saveJob(sessionId: string, id: string, value: unknown): Promise<void> {
		await this.assertSession(sessionId);
		const dir = join(this.directory, "jobs", createHash("sha256").update(sessionId).digest("hex"));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const target = join(dir, checkedId(id) + ".json");
		const temporary = target + "." + randomUUID() + ".partial";
		const bytes = Buffer.from(JSON.stringify(value));
		if (bytes.length > 800000) throw new Error("Media job metadata exceeds budget");
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, target);
			try {
				await this.assertSession(sessionId);
			} catch (error) {
				await unlink(target).catch(() => {});
				throw error;
			}
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}
	async removeJob(sessionId: string, id: string, outputs: readonly StudioMediaAsset[]): Promise<void> {
		const key = createHash("sha256").update(sessionId).digest("hex");
		await unlink(join(this.directory, "jobs", key, checkedId(id) + ".json")).catch(error => {
			if (error.code !== "ENOENT") throw error;
		});
		await Promise.all(
			outputs.map(output =>
				unlink(join(this.directory, "outputs", key, checkedId(output.artifactId) + ".bin")).catch(() => {}),
			),
		);
	}
	async readJobs(sessionId: string): Promise<unknown[]> {
		await this.assertSession(sessionId);
		const dir = join(this.directory, "jobs", createHash("sha256").update(sessionId).digest("hex"));
		const names = await readdir(dir).catch(() => []);
		const jobs: unknown[] = [];
		for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).slice(-1000)) {
			try {
				const file = join(dir, name);
				const stat = await lstat(file);
				if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 800000)
					jobs.push(JSON.parse(await readFile(file, "utf8")));
			} catch {
				/* Corrupt/incomplete metadata is not a resumable job. */
			}
		}
		return jobs;
	}
}
