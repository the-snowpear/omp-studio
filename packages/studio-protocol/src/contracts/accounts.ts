export interface AccountQuotaWindow {
  id: string; label: string; status: "ok" | "warning" | "exhausted" | "unknown";
  usedFraction?: number; resetsAt?: number; model?: string;
}
export interface AccountResetCredit {
  title: string; status?: string; expiresAt?: string; remainingCount?: number;
  usable?: boolean; requiresLimit?: boolean; clears: string[];
}
export interface AccountResetStatus {
  state: "unfetched" | "available" | "unavailable";
  availableCount?: number; redeemableCount?: number; eligible?: boolean; credits: AccountResetCredit[];
}
export interface StudioAccountStatus {
  id: string; provider: string; label: string; organization?: string;
  source: "oauth" | "api-key" | "ambient"; active: boolean;
  limits: AccountQuotaWindow[]; reportedAt?: number; resets: AccountResetStatus;
}
export interface AccountStatusResult {
  accounts: StudioAccountStatus[];
  unassigned: Array<{ provider: string; reportedAt: number; limits: AccountQuotaWindow[] }>;
  refreshedAt?: number; refreshing: boolean; usageUnavailable: boolean; truncated: boolean;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid account status object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown account status field");
  return row;
}
function text(value: unknown): void { if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value)) throw new Error("Invalid account status text"); }
function number(value: unknown): void { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid account status number"); }
function optional(row: Record<string, unknown>, keys: string[], validate: (value: unknown) => void): void { for (const key of keys) if (row[key] !== undefined) validate(row[key]); }
function boolean(value: unknown): void { if (typeof value !== "boolean") throw new Error("Invalid account status flag"); }
function list(value: unknown, max: number, validate: (value: unknown) => void): void { if (!Array.isArray(value) || value.length > max) throw new Error("Invalid account status list"); value.forEach(validate); }
function quota(value: unknown): void {
  const row = object(value, ["id", "label", "status", "usedFraction", "resetsAt", "model"]);
  text(row.id); text(row.label);
  if (!["ok", "warning", "exhausted", "unknown"].includes(row.status as string)) throw new Error("Invalid quota status");
  optional(row, ["usedFraction", "resetsAt"], number); optional(row, ["model"], text);
}
function resets(value: unknown): void {
  const row = object(value, ["state", "availableCount", "redeemableCount", "eligible", "credits"]);
  if (!["unfetched", "available", "unavailable"].includes(row.state as string)) throw new Error("Invalid reset status");
  optional(row, ["availableCount", "redeemableCount"], number); optional(row, ["eligible"], boolean);
  list(row.credits, 64, value => {
    const credit = object(value, ["title", "status", "expiresAt", "remainingCount", "usable", "requiresLimit", "clears"]);
    text(credit.title); optional(credit, ["status", "expiresAt"], text); optional(credit, ["remainingCount"], number);
    optional(credit, ["usable", "requiresLimit"], boolean); list(credit.clears, 32, text);
  });
}
export function validateAccountStatus(value: unknown): asserts value is AccountStatusResult {
  const result = object(value, ["accounts", "unassigned", "refreshedAt", "refreshing", "usageUnavailable", "truncated"]);
  for (const key of ["refreshing", "usageUnavailable", "truncated"]) boolean(result[key]);
  optional(result, ["refreshedAt"], number);
  list(result.accounts, 200, value => {
    const row = object(value, ["id", "provider", "label", "organization", "source", "active", "limits", "reportedAt", "resets"]);
    for (const key of ["id", "provider", "label"]) text(row[key]);
    optional(row, ["organization"], text); optional(row, ["reportedAt"], number); boolean(row.active);
    if (!["oauth", "api-key", "ambient"].includes(row.source as string)) throw new Error("Invalid account source");
    list(row.limits, 64, quota); resets(row.resets);
  });
  list(result.unassigned, 200, value => {
    const row = object(value, ["provider", "reportedAt", "limits"]); text(row.provider); number(row.reportedAt); list(row.limits, 64, quota);
  });
}
