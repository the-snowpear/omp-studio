/**
 * Shared semantic transport contract types (P0).
 *
 * A `TransportFactory` builds a `ClientTransport` around a
 * `ContractFixtureApi` fake host. The fixture's five method signatures
 * mirror the adapter API shape exactly (bootstrap/query/command/
 * subscribe/close); structural typing guarantees the fixture satisfies
 * every adapter's API type, so the same suite drives desktop and web
 * adapters identically. The remaining members (`calls`, `emit`) are test
 * hooks the adapters never see.
 */

import type {
  ClientBootstrap,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientEvent,
  ClientQueryRequest,
  ClientQueryResponse,
  ClientTransport,
  CommandName,
  QueryName,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";

/** One host-side subscription record, kept in arrival order. */
export interface FixtureSubscription {
  readonly scope: SubscriptionScope;
  readonly listener: (event: ClientEvent) => void;
  /** Set once the unsubscribe function handed out by the host is called. */
  unsubscribed: boolean;
}

/** Deterministic observation surface the suite asserts against. */
export interface FixtureCalls {
  bootstrapCalls: number;
  queryCalls: number;
  commandCalls: number;
  subscribeCalls: number;
  closeCalls: number;
  /**
   * Last request reference received by the host, kept by reference (never
   * copied). The suite mutates its own request after the call and asserts
   * this copy stays pristine, proving the adapter clones on the way in.
   */
  lastQueryRequest: ClientQueryRequest | undefined;
  lastCommandRequest: ClientCommandRequest | undefined;
  subscriptions: FixtureSubscription[];
}

/**
 * Fake-host surface shared by every transport under test. The first five
 * methods are exactly the adapter API shape; the last two are test hooks.
 */
export interface ContractFixtureApi {
  bootstrap(): Promise<ClientBootstrap>;
  query<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): Promise<ClientQueryResponse<TName>>;
  command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>>;
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe;
  close(): Promise<void>;

  /** Test hook: observation surface for forwarding/clone assertions. */
  readonly calls: FixtureCalls;
  /** Test hook: push an event to live subscriptions, scope-filtered. */
  emit(event: ClientEvent): void;
  /**
   * Test hook: make the next `bootstrap()` resolve this value instead of
   * the fixture data (one-shot, cleared by the call it affects). Used to
   * prove transports fail closed on malformed envelopes.
   */
  overrideBootstrap(result: unknown): void;
  /**
   * Test hook: make the next `query()` resolve this value instead of the
   * fixture data (one-shot, cleared by the call it affects). Used to prove
   * transports fail closed on malformed envelopes.
   */
  overrideQueryResponse(response: unknown): void;
  /**
   * Test hook: make the next `command()` resolve this value instead of the
   * fixture data (one-shot, cleared by the call it affects). Used to prove
   * transports fail closed on malformed envelopes.
   */
  overrideCommandResponse(response: unknown): void;
}

/**
 * Builds a `ClientTransport` around a `ContractFixtureApi` fake host.
 * The suite passes this factory to `runTransportContract` for each adapter.
 */
export type TransportFactory = (api: ContractFixtureApi) => ClientTransport;
