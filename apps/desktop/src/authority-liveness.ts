/**
 * Owner-liveness proof behind the Host authority lock.
 *
 * The lock file records which environment owns a profile; this proof shows
 * that owner is still running. Windows holds a named pipe, which the kernel
 * frees when its owner dies. A unix socket file survives a crash, so POSIX
 * never treats "the path exists" as "the owner lives": it connects, and only
 * a refused connection counts as dead. A stale socket is removed only when it
 * is provably this user's socket and still the same inode.
 */
import { lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";

import { privateSocketPath } from "@omp-studio/studio-host";

export interface AuthorityLiveness {
  /** Starts holding the proof; false when another live owner holds it. */
  acquire(environmentKey: string): Promise<boolean>;
  release(environmentKey: string): Promise<void>;
  /** True when this process or another live process holds the proof. */
  isHeld(environmentKey: string): Promise<boolean>;
}

function safeKey(environmentKey: string): string {
  return environmentKey.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function listenExclusive(address: string, onConnection?: (socket: import("node:net").Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = onConnection === undefined ? createServer() : createServer(onConnection);
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(address, () => {
      server.off("error", fail);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Windows: a process-lifetime named pipe the kernel releases with its owner. */
export function createWin32AuthorityLiveness(): AuthorityLiveness {
  const proofs = new Map<string, Server>();
  const address = (environmentKey: string): string => `\\\\.\\pipe\\omp-studio-authority-${safeKey(environmentKey)}`;
  return {
    async acquire(environmentKey) {
      const pipe = address(environmentKey);
      if (proofs.has(pipe)) return true;
      try {
        proofs.set(pipe, await listenExclusive(pipe));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
        throw error;
      }
    },
    async release(environmentKey) {
      const pipe = address(environmentKey);
      const server = proofs.get(pipe);
      if (server === undefined) return;
      proofs.delete(pipe);
      await closeServer(server);
    },
    async isHeld(environmentKey) {
      const pipe = address(environmentKey);
      if (proofs.has(pipe)) return true;
      try {
        await closeServer(await listenExclusive(pipe));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
        throw error;
      }
    },
  };
}

export interface PosixAuthorityLivenessOptions {
  /** Short private directory for the proof socket (see studio-host socket-paths). */
  readonly socketDirectory: () => Promise<string>;
  /** A listener that neither accepts nor refuses within this time counts as alive. */
  readonly probeTimeoutMs?: number;
  /** Test seam; defaults to the current uid. */
  readonly uid?: number;
}

/** macOS: connect-probed unix socket with safe reclamation of crash leftovers. */
export function createPosixAuthorityLiveness(options: PosixAuthorityLivenessOptions): AuthorityLiveness {
  const proofs = new Map<string, Server>();
  const address = async (environmentKey: string): Promise<string> =>
    privateSocketPath(await options.socketDirectory(), `authority-${safeKey(environmentKey)}.sock`);

  const probe = (path: string): Promise<"live" | "stale"> =>
    new Promise((resolve, reject) => {
      const socket = connect(path);
      const settle = (): void => {
        clearTimeout(timer);
        socket.destroy();
      };
      const timer = setTimeout(() => {
        settle();
        resolve("live");
      }, options.probeTimeoutMs ?? 500);
      socket.once("connect", () => {
        settle();
        resolve("live");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        settle();
        // Nobody accepts here. macOS reports ENOTSOCK for a non-socket file;
        // removeStale then refuses to delete it.
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ENOTSOCK") resolve("stale");
        else reject(error);
      });
    });

  const removeStale = async (path: string): Promise<void> => {
    let first;
    try {
      first = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!first.isSocket()) throw new Error("authority proof path is not a socket; refusing to remove it");
    const uid = options.uid ?? process.getuid?.();
    if (uid !== undefined && first.uid !== uid) throw new Error("authority proof socket belongs to another user");
    const second = await lstat(path);
    // Replaced between the two checks: leave it to the next attempt.
    if (second.dev !== first.dev || second.ino !== first.ino) return;
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  return {
    async acquire(environmentKey) {
      const path = await address(environmentKey);
      if (proofs.has(path)) return true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          proofs.set(path, await listenExclusive(path, (socket) => socket.destroy()));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
          if ((await probe(path)) === "live") return false;
          if (attempt === 0) await removeStale(path);
        }
      }
      return false;
    },
    async release(environmentKey) {
      const path = await address(environmentKey);
      const server = proofs.get(path);
      if (server === undefined) return;
      proofs.delete(path);
      // libuv unlinks the socket path before closing the descriptor; unlinking
      // again here could delete a successor's freshly bound socket.
      await closeServer(server);
    },
    async isHeld(environmentKey) {
      const path = await address(environmentKey);
      if (proofs.has(path)) return true;
      return (await probe(path)) === "live";
    },
  };
}
