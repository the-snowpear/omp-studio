/**
 * P1 Desktop IPC channel constants (FRONTEND_INTEGRATION.md §9).
 *
 * These are the ONLY channel names used between Electron Main and the
 * preload bridge. The surface is a fixed named method set — bootstrap /
 * query / command / subscribe / unsubscribe / close — with no generic
 * `invoke(channel, payload)` escape hatch anywhere: a renderer can address
 * exactly these channels and nothing else.
 *
 * The strings are internal to this package: client-contract, the Renderer
 * and the Host facade never see them. Main identifies the client by the
 * sender WebContents; payloads never carry client identity, window id or
 * authority fields.
 *
 * `subscribe` and `unsubscribe` are one logical operation pair: the Renderer
 * chooses the `subscriptionId`, Main owns the Host subscription behind it.
 * Without the id Main could only tear down a whole window's subscriptions
 * (`close`), which is why a renderer that merely stopped listening used to
 * leave a live Host subscription behind.
 */
export const DESKTOP_IPC_CHANNELS: Readonly<{
  /** Renderer -> Main: fetch the bootstrap, no payload. */
  readonly bootstrap: string;
  /** Renderer -> Main: one semantic query envelope. */
  readonly query: string;
  /** Renderer -> Main: one semantic command envelope. */
  readonly command: string;
  /** Renderer -> Main: register one subscription: `{ scope, subscriptionId }`. */
  readonly subscribe: string;
  /** Renderer -> Main: cancel exactly one subscription: `{ subscriptionId }`. */
  readonly unsubscribe: string;
  /** Main -> Renderer: one subscription event: `{ subscriptionIds, event }`. */
  readonly event: string;
  /** Renderer -> Main: close the client session. */
  readonly close: string;
}> = Object.freeze({
  bootstrap: "omp-studio:desktop:bootstrap",
  query: "omp-studio:desktop:query",
  command: "omp-studio:desktop:command",
  subscribe: "omp-studio:desktop:subscribe",
  unsubscribe: "omp-studio:desktop:unsubscribe",
  event: "omp-studio:desktop:event",
  close: "omp-studio:desktop:close",
});

/** Union of every P1 Desktop IPC channel name. */
export type DesktopIpcChannel =
  (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

/**
 * Wire limits of the Desktop IPC protocol, shared by both sides of the bridge.
 *
 * `maxSubscriptionIdsPerEvent` is the maximum number of renderer subscription
 * ids one `event` envelope may carry. Main slices a scope's ids into chunks of
 * at most this size — a bigger fan-out is split into several envelopes, never
 * dropped — and the preload rejects an envelope that exceeds it. Both sides
 * read this constant (Main's `forward`, the preload's envelope guard), so the
 * two cannot drift: a mismatch used to make Main send envelopes the preload
 * silently discarded, so a legal subscription watched an event go by.
 *
 * The value bounds one IPC message: 64 ids plus one event stay small, and a
 * window with hundreds of listeners over one scope still gets exactly-once
 * delivery through a handful of envelopes.
 */
export const DESKTOP_IPC_LIMITS: Readonly<{ maxSubscriptionIdsPerEvent: number }> = Object.freeze({
  maxSubscriptionIdsPerEvent: 64,
});
