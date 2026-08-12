/**
 * In-process semantic transport for tests and P0 fixtures (P0 transports are
 * in-process by design). Implements the exact ClientTransport contract:
 * deterministic bootstrap/query/command handlers, `emit(event)` for tests,
 * value cloning where safe, closed-state enforcement and exact subscription
 * scope filtering.
 */

import type {
  ClientBootstrap,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientError,
  ClientEvent,
  ClientQueryRequest,
  ClientQueryResponse,
  ClientTransport,
  CommandName,
  QueryName,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";

import { toClientError } from "./errors.js";
import { eventMatchesScope } from "./scope.js";

export interface MemoryTransportHandlers {
  bootstrap?(): ClientBootstrap | Promise<ClientBootstrap>;
  query?<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): ClientQueryResponse<TName> | Promise<ClientQueryResponse<TName>>;
  command?<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): ClientCommandAccepted<TName> | Promise<ClientCommandAccepted<TName>>;
}

interface Subscriber {
  readonly scope: SubscriptionScope;
  readonly listener: (event: ClientEvent) => void;
}

/** Deep-clone plain contract values so callers never share mutable objects. */
function clonePlain<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function unavailable(label: string): ClientError {
  return { code: "UNAVAILABLE", message: `no handler registered for ${label}` };
}

export class MemoryClientTransport implements ClientTransport {
  private readonly handlers: MemoryTransportHandlers;
  private closed = false;
  private readonly subscribers: Subscriber[] = [];

  constructor(handlers: MemoryTransportHandlers = {}) {
    this.handlers = handlers;
  }

  async bootstrap(): Promise<ClientBootstrap> {
    this.assertOpen();
    return clonePlain(await this.invoke(() => this.handlers.bootstrap?.(), "bootstrap"));
  }

  async query<TName extends QueryName>(request: ClientQueryRequest<TName>): Promise<ClientQueryResponse<TName>> {
    this.assertOpen();
    return clonePlain(await this.invoke(() => this.handlers.query?.(request), `query ${request.queryName}`));
  }

  async command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>> {
    this.assertOpen();
    return clonePlain(await this.invoke(() => this.handlers.command?.(request), `command ${request.commandName}`));
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.closed) {
      return () => {};
    }
    const subscriber: Subscriber = { scope, listener };
    this.subscribers.push(subscriber);
    return () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  /** Deliver a host-side event to matching subscribers (tests only). */
  emit(event: ClientEvent): void {
    if (this.closed) {
      return;
    }
    const payload = clonePlain(event);
    for (const { scope, listener } of this.subscribers) {
      if (eventMatchesScope(payload, scope)) {
        listener(payload);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.subscribers.length = 0;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw { code: "TRANSPORT_ERROR", message: "transport is closed" } as ClientError;
    }
  }

  private async invoke<T>(handler: () => T | undefined, label: string): Promise<T> {
    let result: T | undefined;
    try {
      result = handler();
    } catch (error) {
      throw toClientError(error);
    }
    if (result === undefined) {
      throw unavailable(label);
    }
    try {
      return await result;
    } catch (error) {
      throw toClientError(error);
    }
  }
}
