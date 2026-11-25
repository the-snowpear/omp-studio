import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { connect, createServer } from "node:net";
import { readFile, writeFile, rm, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateSocketDirectory,
  privateSocketPath,
  createWindowsBridgeAclPort,
} from "@omp-studio/studio-host";
import { RemotePeer } from "../remote/wire.js";
import { secureRemoteDirectory } from "../remote/platform.js";

export interface LocalEndpoint {
  endpoint: string;
  token: string;
}
export type HostCall = {
  action: string;
  input?: any;
  contextId?: string;
  version?: string;
};

export async function serveLocalChannel(
  directory: string,
  onClient: (peer: RemotePeer) => (call: HostCall) => Promise<unknown>,
) {
  const privateDirectory = join(directory, "web");
  await secureRemoteDirectory(privateDirectory);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-studio-host-${randomUUID()}`
      : privateSocketPath(
          await ensurePrivateSocketDirectory(`shared-host:${directory}`),
          `${randomUUID()}.sock`,
        );
  const token = randomBytes(32).toString("base64url");
  const peers = new Set<RemotePeer>();
  const server = createServer((socket) => {
    const peer = new RemotePeer(socket, socket);
    peers.add(peer);
    let handle: ((call: HostCall) => Promise<unknown>) | undefined;
    const timer = setTimeout(() => peer.close(), 5000);
    timer.unref();
    peer.onClose(() => {
      clearTimeout(timer);
      peers.delete(peer);
    });
    peer.handle(async (method, input) => {
      if (!handle) {
        const supplied =
          typeof input === "object" && input !== null && "token" in input
            ? input.token
            : undefined;
        if (
          method !== "hello" ||
          typeof supplied !== "string" ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          throw new Error("unauthenticated");
        clearTimeout(timer);
        handle = onClient(peer);
        return { protocolVersion: 1 };
      }
      if (
        method !== "host.call" ||
        !input ||
        typeof input !== "object" ||
        !("action" in input) ||
        typeof input.action !== "string"
      )
        throw new Error("Invalid Host request");
      return handle(input as HostCall);
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      done();
    });
  });
  try {
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    const path = join(privateDirectory, "host-endpoint.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    if (process.platform === "win32")
      await createWindowsBridgeAclPort().createSecureTokenFile(
        temporary,
        JSON.stringify({ endpoint, token }),
      );
    else
      await writeFile(temporary, JSON.stringify({ endpoint, token }), {
        flag: "wx",
        mode: 0o600,
      });
    await rename(temporary, path);
    return {
      async close() {
        for (const peer of peers) peer.close();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    server.close();
    throw error;
  }
}

export async function connectLocalChannel(
  directory: string,
): Promise<RemotePeer> {
  const endpoint = JSON.parse(
    await readFile(join(directory, "web", "host-endpoint.json"), "utf8"),
  ) as LocalEndpoint;
  const socket = connect(endpoint.endpoint);
  await new Promise<void>((done, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      done();
    });
  });
  const peer = new RemotePeer(socket, socket);
  try {
    await peer.request("hello", { token: endpoint.token });
    return peer;
  } catch (error) {
    peer.close();
    throw error;
  }
}
