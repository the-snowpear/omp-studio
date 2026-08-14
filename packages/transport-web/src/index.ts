/**
 * @omp-studio/transport-web
 *
 * P0 browser-port transport adapter (FRONTEND_INTEGRATION.md §10): a typed,
 * in-process semantic boundary over {@link OmpStudioWebApi}. The adapter
 * forwards exact envelopes without reinterpretation, clones defensively in
 * both directions, and fails closed on malformed responses or use after
 * close. The HTTP/WebSocket implementation (P2) replaces the api object's
 * internals; this surface does not change.
 *
 * Browser-compatible: no Node, Electron, fetch, WebSocket, URL or
 * channel-name concepts anywhere in this package, and no secret-bearing
 * fields.
 */

export type { OmpStudioWebApi } from "./web-transport.js";
export { WebClientTransport, createWebTransport } from "./web-transport.js";
export { WebTransportError } from "./errors.js";
export { LoopbackWebAdapter, createLoopbackHttpServer } from "./server.js";
export type { WebAdapterHost, WebAdapterOptions } from "./server.js";
export { BrowserWebClientTransport } from "./browser-client.js";
export type { BrowserWebClientOptions, WebSocketLike } from "./browser-client.js";
