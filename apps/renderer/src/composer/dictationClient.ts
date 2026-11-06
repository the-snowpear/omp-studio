import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { DictationConfiguration, DictationResultMap } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";

export async function dictationCommand<K extends keyof DictationResultMap>(client: StudioClient, kind: K, input: CommandInput<K>): Promise<DictationResultMap[K]> {
  const handle = await client.command(kind, input);
  return (await waitReceipt<{ result: DictationResultMap[K] }>(client, handle.requestId, 30000)).result;
}

const CONSENT_KEY = "omp.dictationConsent.v2";
const accepted = new Set<string>();
function consentKey(configuration: DictationConfiguration): string {
  return `${configuration.cloud ? "cloud" : "download"}:${configuration.configurationId}`;
}
export function needsDictationConsent(configuration: DictationConfiguration): boolean {
  if (!configuration.cloud && !configuration.downloadRequired) return false;
  const key = consentKey(configuration);
  if (accepted.has(key)) return false;
  try { return !(JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "[]") as string[]).includes(key); }
  catch { return true; }
}
export function acceptDictationConsent(configuration: DictationConfiguration): void {
  const key = consentKey(configuration);
  accepted.add(key);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "[]");
    const keys = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : [];
    localStorage.setItem(CONSENT_KEY, JSON.stringify([...new Set([...keys, key])].slice(-40)));
  } catch { /* Consent remains in memory when storage is blocked. */ }
}
