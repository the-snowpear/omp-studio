import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyUpdateManifest, writeJsonAtomic, type SignedUpdateManifest, type UpdateComponent, type UpdateChannel } from "@omp-studio/runtime-installer";
import { withUpdateRequest, type UpdateRequestAttempt, type UpdateRequestLog, type UpdateRequestPolicy } from "./update-request.js";

export interface DiscoveredUpdates { app?: SignedUpdateManifest; runtime?: SignedUpdateManifest; baselines?: Partial<Record<UpdateComponent, SignedUpdateManifest>> }
interface ReleaseAsset { id?: number; updated_at?: string; name: string; browser_download_url: string }
interface ReleaseRow { draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[] }
interface DiscoveryCache {
  schema: 1;
  catalog: Record<string, { etag?: string; rows: ReleaseRow[] }>;
  manifests: Record<string, { assetId: number; updatedAt: string; envelope: SignedUpdateManifest }>;
}
class InvalidUpdateManifestError extends Error {}
async function boundedText(response: Response, limit: number, attempt: UpdateRequestAttempt): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty update response");
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await attempt.read(reader);
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("Update response too large");
      parts.push(value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    const cancelled = reader.cancel().catch(() => {});
    if (!attempt.signal.aborted) await cancelled;
    reader.releaseLock();
  }
}
/** Discovery never relies on Latest: Runtime-only releases must not hide desktop updates. */
export async function discoverUpdates(input: {
  repo: string; platform: string; channel: UpdateChannel; mirror: string;
  keys: Readonly<Record<string, string | Buffer>>; signal: AbortSignal;
  fetcher?: typeof fetch; watermarks: Record<string, number>;
  currentVersions?: Partial<Record<UpdateComponent, string | undefined>>;
  cacheDirectory?: string | undefined;
  log?: UpdateRequestLog | undefined;
  requestPolicy?: Partial<UpdateRequestPolicy> | undefined;
}): Promise<DiscoveredUpdates> {
  const result: DiscoveredUpdates = {};
  const assetName = `updates-${input.platform}.json`;
  const cachePath = input.cacheDirectory ? join(input.cacheDirectory, `${createHash("sha256").update(`${input.repo}:${input.platform}`).digest("hex")}.json`) : undefined;
  let cache: DiscoveryCache = { schema: 1, catalog: {}, manifests: {} };
  if (cachePath) {
    try {
      const saved = JSON.parse(await readFile(cachePath, "utf8")) as DiscoveryCache;
      if (saved.schema === 1 && saved.catalog && saved.manifests) cache = saved;
    } catch { /* The cache is optional; discovery still verifies fresh manifests. */ }
  }
  let manifestsSeen = 0, manifestsVerified = 0;
  try {
    for (let page = 1; page <= 10; page++) {
      const url = `https://api.github.com/repos/${input.repo}/releases?per_page=100&page=${page}`;
      const rows = await withUpdateRequest({ ...input, url, stage: "catalog", acceptNotModified: true }, async attempt => {
        const previous = cache.catalog[attempt.url];
        const response = await attempt.request({ Accept: "application/vnd.github+json", ...(previous?.etag && Array.isArray(previous.rows) ? { "If-None-Match": previous.etag } : {}) });
        if (response.status === 304) {
          if (!previous || !Array.isArray(previous.rows)) throw new Error("Update catalog cache is missing");
          return previous.rows;
        }
        const value: unknown = JSON.parse(await boundedText(response, 8 * 1024 * 1024, attempt));
        if (!Array.isArray(value)) throw new Error("Invalid release response");
        const etag = response.headers.get("etag");
        cache.catalog[attempt.url] = { rows: value as ReleaseRow[], ...(etag ? { etag } : {}) };
        return value as ReleaseRow[];
      });
      for (const row of rows) {
        if (row.draft) continue;
        // Stable desktops always use stable releases; Canary is opt-in for Runtime.
        if (row.prerelease && input.channel !== "canary") continue;
        const asset = row.assets?.find(a => a.name === assetName);
        if (!asset) continue;
        manifestsSeen++;
        if (!asset.browser_download_url.startsWith(`https://github.com/${input.repo}/releases/download/`)) continue;
        let envelope: SignedUpdateManifest | undefined;
        const saved = cache.manifests[asset.browser_download_url];
        if (saved && saved.assetId === asset.id && saved.updatedAt === asset.updated_at) {
          try { envelope = verifyUpdateManifest(saved.envelope, input.keys, input.repo, input.platform); }
          catch { delete cache.manifests[asset.browser_download_url]; }
        }
        if (!envelope) {
          try {
            envelope = await withUpdateRequest({ ...input, url: asset.browser_download_url, stage: "manifest" }, async attempt => {
              const body = await boundedText(await attempt.request(), 1024 * 1024, attempt);
              // A mirror can return an HTML error page with HTTP 200. Verify
              // content before considering that transport attempt successful.
              try { return verifyUpdateManifest(JSON.parse(body), input.keys, input.repo, input.platform); }
              catch (error) { throw new InvalidUpdateManifestError("Invalid signed update manifest", { cause: error }); }
            });
          } catch (error) {
            input.signal.throwIfAborted();
            // A corrupt release may be skipped; an unreachable release must
            // fail the check rather than masquerade as "no update".
            if (!(error instanceof InvalidUpdateManifestError)) throw error;
            input.log?.write("warn", "update.manifest.invalid", `stage=manifest host=${new URL(asset.browser_download_url).hostname}`);
            continue;
          }
          if (asset.id !== undefined && asset.updated_at !== undefined) cache.manifests[asset.browser_download_url] = { assetId: asset.id, updatedAt: asset.updated_at, envelope };
        }
        manifestsVerified++;
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
    if (manifestsSeen > 0 && manifestsVerified === 0) throw new Error("未取得可验证的更新清单，请稍后重试");
    for (const kind of ["app", "runtime"] as UpdateComponent[]) {
      const candidate = result[kind]?.manifest[kind];
      if (candidate && candidate.sequence < (input.watermarks[`${kind}:${candidate.channel}:${input.platform}`] ?? 0)) throw new Error("Update catalog rollback rejected");
    }
    return result;
  } finally {
    if (cachePath && input.cacheDirectory) {
      await mkdir(input.cacheDirectory, { recursive: true }).then(() => writeJsonAtomic(cachePath, cache)).catch(() => {
        input.log?.write("warn", "update.cache.write_failed", "stage=catalog");
      });
    }
  }
}
