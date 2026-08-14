/**
 * Time and identifier generation for the platform-neutral client.
 *
 * Browser-safe by design: the default implementation uses
 * `globalThis.crypto.randomUUID()` and `Date`, with no Node or Electron
 * imports anywhere in this package's `src`. Tests inject a deterministic
 * implementation.
 */

import type { CommandRequestId, IdempotencyKey } from "@omp-studio/client-contract";

export interface ClientClockAndIds {
  /** Current time as an ISO-8601 string. */
  now(): string;
  /** Fresh opaque request id for a submitted command. */
  newRequestId(): CommandRequestId;
  /** Fresh idempotency key when the caller did not supply one. */
  newIdempotencyKey(): IdempotencyKey;
}

interface CryptoLike {
  readonly randomUUID?: () => string;
}

function randomUuid(): string {
  const cryptoLike = (globalThis as { crypto?: CryptoLike }).crypto;
  // Member call keeps `this` bound: extracting `crypto.randomUUID` and
  // calling it detached throws "Illegal invocation" in Chromium.
  if (cryptoLike !== undefined && typeof cryptoLike.randomUUID === "function") {
    return cryptoLike.randomUUID();
  }
  // Fallback only for exotic environments without Web Crypto. Never
  // Node-specific; the same path runs in any browser.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createBrowserClockAndIds(): ClientClockAndIds {
  return {
    now: () => new Date().toISOString(),
    newRequestId: () => randomUuid() as CommandRequestId,
    newIdempotencyKey: () => randomUuid() as IdempotencyKey,
  };
}
