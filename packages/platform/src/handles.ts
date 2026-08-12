/**
 * Opaque handles that cross the platform boundary.
 *
 * Every handle here is a branded string whose content is meaningful only to
 * the platform implementation that produced it. The contract never exposes a
 * PID, a pipe name, an executable name, or a filesystem path through these
 * types, and Renderer-facing contracts must never receive them.
 */

/** @internal Structural branding helper. */
export type Brand<T, TName extends string> = T & { readonly __brand: TName };

/** Opaque reference to a filesystem resource the platform can reveal to the user (for example, in its file manager). */
export type ResourceHandle = Brand<string, "ResourceHandle">;

/** Opaque reference to a runtime process under platform containment. Never a PID and never meaningful to a Renderer. */
export type RuntimeProcessHandle = Brand<string, "RuntimeProcessHandle">;

/** @internal Shared boundary validation for opaque handle constructors. */
export function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

/** Constructs a {@link ResourceHandle}; rejects empty values at the package boundary. */
export function resourceHandle(value: string): ResourceHandle {
  assertNonEmpty(value, "ResourceHandle");
  return value as ResourceHandle;
}

/** Constructs a {@link RuntimeProcessHandle}; rejects empty values at the package boundary. */
export function runtimeProcessHandle(value: string): RuntimeProcessHandle {
  assertNonEmpty(value, "RuntimeProcessHandle");
  return value as RuntimeProcessHandle;
}
