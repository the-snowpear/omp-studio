import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { once } from "node:events";
import {
  ArtifactLibrary,
  type ArtifactRegistration,
} from "@omp-studio/studio-host";
import { activeArtifactLibrary } from "../artifact-library.js";
import type { SharedHostConnection } from "./client.js";

/** A private desktop connection streams its imports to the single catalog writer. */
export class HostArtifactUploads {
  readonly #uploads = new Map<
    string,
    {
      path: string;
      stream: WriteStream;
      input: ArtifactRegistration;
      bytes: number;
    }
  >();
  constructor(readonly directory: string) {}
  async begin(input: ArtifactRegistration): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const path = join(this.directory, id);
    const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
    await once(stream, "open");
    this.#uploads.set(id, { path, stream, input, bytes: 0 });
    return id;
  }
  async append(id: string, data: string): Promise<void> {
    const upload = this.#uploads.get(id);
    if (!upload) throw new Error("Unknown upload");
    const bytes = Buffer.from(data, "base64");
    upload.bytes += bytes.length;
    if (bytes.length > 262144 || upload.bytes > 2 * 1024 * 1024 * 1024)
      throw new Error("Artifact exceeds upload size limit");
    await new Promise<void>((resolve, reject) =>
      upload.stream.write(bytes, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  async finish(id: string) {
    const upload = this.#uploads.get(id);
    if (!upload) throw new Error("Unknown upload");
    this.#uploads.delete(id);
    try {
      upload.stream.end();
      await once(upload.stream, "close");
      return await activeArtifactLibrary().register(
        upload.input,
        createReadStream(upload.path),
      );
    } finally {
      await rm(upload.path, { force: true });
    }
  }
  async abort(id: string): Promise<void> {
    const upload = this.#uploads.get(id);
    if (!upload) return;
    this.#uploads.delete(id);
    upload.stream.destroy();
    if (!upload.stream.closed) await once(upload.stream, "close");
    await rm(upload.path, { force: true });
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.#uploads.values()].map(async (upload) => {
        upload.stream.destroy();
        if (!upload.stream.closed) await once(upload.stream, "close");
        await rm(upload.path, { force: true });
      }),
    );
    this.#uploads.clear();
  }
}

export class SharedArtifactLibrary extends ArtifactLibrary {
  constructor(
    directory: string,
    readonly connection: Pick<SharedHostConnection, "call">,
  ) {
    super({ profileDirectory: directory });
  }
  override state(): ReturnType<ArtifactLibrary["state"]> {
    return this.connection.call("artifacts.state");
  }
  override setDirectory(
    path: string,
  ): ReturnType<ArtifactLibrary["setDirectory"]> {
    return this.connection.call("artifacts.setDirectory", path);
  }
  override list(
    input?: Parameters<ArtifactLibrary["list"]>[0],
  ): ReturnType<ArtifactLibrary["list"]> {
    return this.connection.call("artifacts.list", input);
  }
  override resolve(id: string): ReturnType<ArtifactLibrary["resolve"]> {
    return this.connection.call("artifacts.resolve", id);
  }
  override readText(id: string): ReturnType<ArtifactLibrary["readText"]> {
    return this.connection.call("artifacts.readText", id);
  }
  override findByRunId(id: string): ReturnType<ArtifactLibrary["findByRunId"]> {
    return this.connection.call("artifacts.findByRunId", id);
  }
  override remove(id: string): Promise<void> {
    return this.connection.call("artifacts.remove", id);
  }
  override retain(id: string): ReturnType<ArtifactLibrary["retain"]> {
    return this.connection.call("artifacts.retain", id);
  }
  override discardRun(id: string): Promise<void> {
    return this.connection.call("artifacts.discardRun", id);
  }
  override detachSession(id: string): Promise<void> {
    return this.connection.call("artifacts.detachSession", id);
  }
  override finishSession(id: string, remove: boolean): Promise<void> {
    return this.connection.call("artifacts.finishSession", { id, remove });
  }
  override async register(
    input: ArtifactRegistration,
    content: AsyncIterable<Uint8Array>,
  ): ReturnType<ArtifactLibrary["register"]> {
    const id = await this.connection.call<string>("artifacts.begin", input);
    try {
      for await (const bytes of content) {
        for (let offset = 0; offset < bytes.byteLength; offset += 262144) {
          await this.connection.call("artifacts.append", {
            id,
            data: Buffer.from(bytes.subarray(offset, offset + 262144)).toString(
              "base64",
            ),
          });
        }
      }
      return await this.connection.call("artifacts.finish", id);
    } catch (error) {
      await this.connection.call("artifacts.abort", id).catch(() => {});
      throw error;
    }
  }
}
