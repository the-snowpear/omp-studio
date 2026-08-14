/** Normative opaque identifiers. Never expose OMP paths or process handles. */
type Brand<T, TName extends string> = T & { readonly __brand: TName };

export type EnvironmentId = Brand<string, "EnvironmentId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ThreadId = Brand<string, "ThreadId">;
export type RuntimeId = Brand<string, "RuntimeId">;
export type RuntimeInstanceId = Brand<string, "RuntimeInstanceId">;
export type SessionId = Brand<string, "SessionId">;
export type RequestId = Brand<string, "RequestId">;
export type CommandId = Brand<string, "CommandId">;
export type InteractionId = Brand<string, "InteractionId">;
export type AgentId = Brand<string, "AgentId">;
export type JobId = Brand<string, "JobId">;
export type ResourceHandle = Brand<string, "ResourceHandle">;
export type OpaqueCursor = Brand<string, "OpaqueCursor">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export type RuntimeEpoch = Brand<number, "RuntimeEpoch">;
export type StateVersion = Brand<number, "StateVersion">;
export type EventSeq = Brand<number, "EventSeq">;
export type CommitSeq = Brand<number, "CommitSeq">;
export type Generation = Brand<number, "Generation">;

