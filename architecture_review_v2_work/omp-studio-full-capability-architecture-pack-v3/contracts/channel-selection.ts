import type { CapabilityRoute, CapabilitySurface, ResourceScope } from "./capability-types";

export interface CapabilityInvocation<T = unknown> {
  commandId: string;
  capabilityId: string;
  surface: CapabilitySurface;
  input: T;
  scope: ResourceScope;
  expectedRuntimeEpoch?: string;
  expectedControlLeaseRevision?: number;
  expectedWorkspaceLeaseRevision?: number;
}

export interface TrustedInvocationContext {
  clientId: string;
  authzRevision: number;
  scope: ResourceScope;
}

export interface ChannelAdapter {
  readonly channel: string;
  probe(scope: ResourceScope): Promise<void>;
  supports(capabilityId: string, surface: CapabilitySurface, scope: ResourceScope): Promise<CapabilityRoute | null>;
  invoke<TInput, TOutput>(request: CapabilityInvocation<TInput>, context: TrustedInvocationContext): Promise<TOutput>;
}

/**
 * Selection is policy-driven. A lower-level channel must never be chosen merely
 * because a higher-level call failed unless that exact capability declares the
 * fallback safe and semantics-preserving.
 */
export interface CapabilityBroker {
  resolve(capabilityId: string, surface: CapabilitySurface, scope: ResourceScope): Promise<CapabilityRoute>;
  invoke<TInput, TOutput>(request: CapabilityInvocation<TInput>, context: TrustedInvocationContext): Promise<TOutput>;
  refresh(scope: ResourceScope): Promise<void>;
}

/**
 * Invocation order is fixed: authenticate/authorize scope, resolve opaque IDs,
 * validate authz revision + runtime epoch + leases, create/update the command
 * ledger, select one declared semantics-preserving route, then invoke it.
 * Adapter failure never authorizes an undeclared fallback.
 */
