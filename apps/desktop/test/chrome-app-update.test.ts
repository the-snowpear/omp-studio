import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSemver,
  findWindowsInstallerAsset,
  parseSemver,
  checkGitHubReleaseUpdate,
  registerChromeAppUpdateIpc,
} from "../src/chrome-app-update.js";
import { CHROME_APP_UPDATE_CHANNELS } from "../src/chrome-app-update-shared.js";

test("parseSemver parses semantic version string correctly", () => {
  assert.deepEqual(parseSemver("0.1.0"), { major: 0, minor: 1, patch: 0 });
  assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver("v2.0.0-beta.1"), { major: 2, minor: 0, patch: 0, prerelease: "beta.1" });
  assert.equal(parseSemver("invalid"), undefined);
});

test("compareSemver orders versions accurately", () => {
  assert.ok(compareSemver("0.2.0", "0.1.0") > 0);
  assert.ok(compareSemver("0.1.0", "0.2.0") < 0);
  assert.equal(compareSemver("0.1.0", "v0.1.0"), 0);
  assert.ok(compareSemver("1.0.0", "1.0.0-beta") > 0);
  assert.ok(compareSemver("1.0.1", "1.0.0") > 0);
});

test("findWindowsInstallerAsset selects correct setup exe", () => {
  const assets = [
    { name: "source.tar.gz", browser_download_url: "https://example.com/source.tar.gz", size: 100 },
    { name: "OMP-Studio-Setup-0.2.0-win-x64.exe", browser_download_url: "https://example.com/setup.exe", size: 5000 },
  ];
  const matched = findWindowsInstallerAsset(assets);
  assert.ok(matched !== undefined);
  assert.equal(matched?.name, "OMP-Studio-Setup-0.2.0-win-x64.exe");
  assert.equal(matched?.downloadUrl, "https://example.com/setup.exe");
  assert.equal(matched?.size, 5000);
});

test("checkGitHubReleaseUpdate detects new release", async () => {
  const fakeFetcher = async () =>
    new Response(
      JSON.stringify({
        tag_name: "v0.2.0",
        name: "OMP Studio 0.2.0 Release",
        body: "### Features\n- Auto update supported",
        html_url: "https://github.com/the-snowpear/omp-studio/releases/tag/v0.2.0",
        published_at: "2026-08-20T00:00:00Z",
        assets: [
          {
            name: "OMP-Studio-Setup-0.2.0-win-x64.exe",
            browser_download_url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.2.0/setup.exe",
            size: 123456,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await checkGitHubReleaseUpdate({
    currentVersion: "0.1.0",
    fetcher: fakeFetcher,
  });

  assert.equal(result.available, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.name, "OMP Studio 0.2.0 Release");
  assert.equal(result.assetName, "OMP-Studio-Setup-0.2.0-win-x64.exe");
  assert.equal(result.downloadUrl, "https://github.com/the-snowpear/omp-studio/releases/download/v0.2.0/setup.exe");
});

test("checkGitHubReleaseUpdate handles equal or older version", async () => {
  const fakeFetcher = async () =>
    new Response(
      JSON.stringify({
        tag_name: "v0.1.0",
        assets: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await checkGitHubReleaseUpdate({
    currentVersion: "0.1.0",
    fetcher: fakeFetcher,
  });

  assert.equal(result.available, false);
  assert.equal(result.version, "0.1.0");
});

test("registerChromeAppUpdateIpc handles check, download, install channels", async () => {
  const handlers = new Map<string, (event: any, payload?: any) => Promise<any>>();
  const ipcMain = {
    handle(channel: string, listener: any) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };

  let openedPath = "";
  const handle = registerChromeAppUpdateIpc({
    ipcMain,
    isTrustedSender: () => true,
    currentVersion: "0.1.0",
    updatesDirectory: "D:/temp/updates",
    fetcher: async () =>
      new Response(JSON.stringify({ tag_name: "v0.2.0", assets: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    openPath: (p) => {
      openedPath = p;
      return "";
    },
  });

  const checkHandler = handlers.get(CHROME_APP_UPDATE_CHANNELS.check);
  assert.ok(checkHandler);
  const checkRes = await checkHandler({ sender: { isDestroyed: () => false, getURL: () => "https://app" } });
  assert.equal(checkRes.available, true);

  const installHandler = handlers.get(CHROME_APP_UPDATE_CHANNELS.install);
  assert.ok(installHandler);
  const installRes = await installHandler(
    { sender: { isDestroyed: () => false, getURL: () => "https://app" } },
    { filePath: "C:/temp/setup.exe" },
  );
  assert.deepEqual(installRes, { ok: true });
  assert.equal(openedPath, "C:/temp/setup.exe");

  handle.dispose();
  assert.equal(handlers.size, 0);
});
