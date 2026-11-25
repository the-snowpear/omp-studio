/**
 * Refreshes shared/release.snapshot.json from the latest GitHub release: the
 * version, publish time and installer sizes the page falls back on when
 * GitHub can't be reached from the visitor's network. Runs before every
 * `npm run build`, so a release needs no edit here; the page itself also asks
 * GitHub on load, so this file only decides what shows first.
 *
 * A build never fails because of this: with no network, a rate limit or no
 * installers on the release, the existing snapshot is kept. Set GITHUB_TOKEN
 * (or GH_TOKEN) to lift the anonymous rate limit, e.g. on a shared CI runner.
 *   npm run release:sync
 */
import { readFile, writeFile } from "node:fs/promises";
import { REPO, fromGithub } from "../shared/github-release.ts";

const OUT = new URL("../shared/release.snapshot.json", import.meta.url);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const keep = (why) => console.warn(`[release] ${why}; keeping the current snapshot`);

let latest;
try {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", ...(token && { Authorization: `Bearer ${token}` }) },
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) latest = fromGithub(await res.json());
  else keep(`GitHub answered ${res.status}`);
} catch (error) {
  keep(`could not reach GitHub (${error.message})`);
}

if (latest === null) keep("the latest release has no installers");
else if (latest) {
  const before = (await readFile(OUT, "utf8").catch(() => "")).replace(/\r\n/g, "\n");
  const after = `${JSON.stringify(latest, null, 2)}\n`;
  if (before === after) console.log(`[release] snapshot is already v${latest.version}`);
  else {
    await writeFile(OUT, after);
    const was = (() => { try { return `v${JSON.parse(before).version}`; } catch { return "none"; } })();
    console.log(`[release] snapshot ${was} -> v${latest.version}`);
  }
}
