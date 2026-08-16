/**
 * Public-conversation safety checks shared by the plan 07 gate.
 *
 * Canonical fixtures must pass `assertConversationPublicSafe`. Unsafe
 * payloads exist only as negative cases and are never used as Host/Client
 * success fixtures.
 */

import { CONVERSATION_REDACT_KEY_PATTERN } from "@omp-studio/studio-protocol";

/** Substrings that must never appear on a public conversation payload. */
export const CONVERSATION_FORBIDDEN_SUBSTRINGS = [
  "sk-live-secret",
  "Bearer super-secret",
  "providerPayload",
  "C:\\Users\\alice",
  "/Users/alice",
  "document.cookie",
  "<script>",
  "onerror=",
] as const;

export function findConversationSafetyViolations(value: unknown): string[] {
  const violations: string[] = [];
  walk(value, "$", violations);
  return violations;
}

function walk(value: unknown, path: string, violations: string[]): void {
  if (typeof value === "string") {
    for (const needle of CONVERSATION_FORBIDDEN_SUBSTRINGS) {
      if (value.includes(needle)) {
        violations.push(`forbidden substring ${JSON.stringify(needle)} at ${path}`);
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, violations));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CONVERSATION_REDACT_KEY_PATTERN.test(key)) {
      violations.push(`redacted key ${JSON.stringify(key)} at ${path}`);
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      violations.push(`prototype-pollution key ${JSON.stringify(key)} at ${path}`);
    }
    walk(item, `${path}.${key}`, violations);
  }
}

export function assertConversationPublicSafe(value: unknown): void {
  const violations = findConversationSafetyViolations(value);
  if (violations.length !== 0) {
    throw new Error(`conversation public payload is unsafe:\n${violations.join("\n")}`);
  }
}
