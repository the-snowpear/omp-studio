import { verifyUpdateManifest, type SignedUpdateManifest, type UpdateComponent, type UpdateChannel } from "@omp-studio/runtime-installer";
import { applyMirror } from "./update-index.js";

export interface DiscoveredUpdates { app?: SignedUpdateManifest; runtime?: SignedUpdateManifest; baselines?: Partial<Record<UpdateComponent, SignedUpdateManifest>> }
async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty update response");
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("Update response too large");
      parts.push(value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Discovery never relies on Latest: Runtime-only releases must not hide desktop updates. */
export async function discoverUpdates(input: {
  repo: string; platform: string; channel: UpdateChannel; mirror: string;
  keys: Readonly<Record<string, string | Buffer>>; signal: AbortSignal;
  fetcher?: typeof fetch; watermarks: Record<string, number>;
  currentVersions?: Partial<Record<UpdateComponent, string | undefined>>;
}): Promise<DiscoveredUpdates> {
  const fetcher = input.fetcher ?? fetch, result: DiscoveredUpdates = {};
  const assetName = `updates-${input.platform}.json`;
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(applyMirror(input.mirror, `https://api.github.com/repos/${input.repo}/releases?per_page=100&page=${page}`), { signal: input.signal, headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`Release discovery HTTP ${response.status}`);
    const rows: unknown = JSON.parse(await boundedText(response, 8 * 1024 * 1024));
    if (!Array.isArray(rows)) throw new Error("Invalid release response");
    for (const row of rows as Array<{ draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; browser_download_url: string }> }>) {
      if (row.draft) continue;
      // Stable desktops always use stable releases; Canary is opt-in for Runtime.
      if (row.prerelease && input.channel !== "canary") continue;
      const asset = row.assets?.find(a => a.name === assetName);
      if (!asset) continue;
      let envelope: SignedUpdateManifest;
      try {
        if (!asset.browser_download_url.startsWith(`https://github.com/${input.repo}/releases/download/`)) throw new Error("Invalid manifest source");
        const res = await fetcher(applyMirror(input.mirror, asset.browser_download_url), { signal: input.signal });
        if (!res.ok) throw new Error(`Update manifest HTTP ${res.status}`);
        const text = await boundedText(res, 1024 * 1024);
        envelope = verifyUpdateManifest(JSON.parse(text), input.keys, input.repo, input.platform);
      } catch {
        input.signal.throwIfAborted();
        // One corrupt release must not hide every later update: skip it and
        // keep scanning. Sequence conflicts and catalog rollback still throw.
        continue;
      }
      for (const kind of ["app", "runtime"] as UpdateComponent[]) {
        const candidate = envelope.manifest[kind];
        const wanted = kind === "app" ? "stable" : input.channel;
        if (!candidate || candidate.channel !== wanted || (kind === "app" && row.prerelease)) continue;
        if (candidate.version === input.currentVersions?.[kind]) (result.baselines ??= {})[kind] = envelope;
        const sequence = result[kind]?.manifest[kind]?.sequence ?? 0;
        const selected = result[kind]?.manifest[kind];
        if (selected && candidate.sequence === sequence && (candidate.version !== selected.version || candidate.file.sha256 !== selected.file.sha256 || candidate.blockmap.sha256 !== selected.blockmap.sha256)) throw new Error("Conflicting signed update sequence");
        if (candidate.sequence > sequence) result[kind] = envelope;
      }
    }
    if (rows.length < 100) break;
    if (page === 10) throw new Error("Release discovery limit reached; refusing incomplete catalog");
  }
  for (const kind of ["app", "runtime"] as UpdateComponent[]) {
    const candidate = result[kind]?.manifest[kind];
    if (candidate && candidate.sequence < (input.watermarks[`${kind}:${candidate.channel}:${input.platform}`] ?? 0)) throw new Error("Update catalog rollback rejected");
  }
  return result;
}
