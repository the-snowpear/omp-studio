import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Readable } from "node:stream";

import {
  CHROME_APP_UPDATE_CHANNELS,
  type AppUpdateInfo,
} from "../src/chrome-app-update-shared.js";
import {
  checkGitHubReleaseUpdate,
  compareSemver,
  downloadInstallerFile,
  findWindowsInstallerAsset,
  parseSemver,
  registerChromeAppUpdateIpc,
  type GitHubReleaseResponse,
} from "../src/chrome-app-update.js";

class FakeIpcMain {
  readonly handlers = new Map<string, (event: any, payload?: any) => Promise<any>>();

  handle(channel: string, listener: (event: any, payload?: any) => Promise<any>): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, sender: any, payload?: any): Promise<any> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler({ sender }, payload);
  }
}

describe("chrome-app-update", () => {
  describe("semver parsing and comparison", () => {
    test("parseSemver parses standard and pre-release versions", () => {
      assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
      assert.deepEqual(parseSemver("v0.1.4-beta.1"), { major: 0, minor: 1, patch: 4, prerelease: "beta.1" });
      assert.equal(parseSemver("invalid"), undefined);
      assert.equal(parseSemver("1.2"), undefined);
    });

    test("compareSemver orders versions correctly", () => {
      assert.ok(compareSemver("0.1.4", "0.1.3") > 0);
      assert.ok(compareSemver("0.1.3", "0.1.4") < 0);
      assert.equal(compareSemver("0.1.4", "0.1.4"), 0);
      assert.ok(compareSemver("1.0.0", "0.9.9") > 0);
      assert.ok(compareSemver("0.1.4", "0.1.4-beta.1") > 0);
      assert.ok(compareSemver("0.1.4-beta.1", "0.1.4") < 0);
    });
  });

  describe("findWindowsInstallerAsset", () => {
    test("selects setup exe and extracts metadata", () => {
      const assets = [
        { name: "source.zip", browser_download_url: "https://example.com/source.zip", size: 100 },
        { name: "OMP-Studio-Setup-0.1.4.exe", browser_download_url: "https://example.com/setup.exe", size: 50000000 },
        { name: "other.exe", browser_download_url: "https://example.com/other.exe", size: 200 },
      ];
      const match = findWindowsInstallerAsset(assets);
      assert.ok(match !== undefined);
      assert.equal(match.name, "OMP-Studio-Setup-0.1.4.exe");
      assert.equal(match.downloadUrl, "https://example.com/setup.exe");
      assert.equal(match.size, 50000000);
    });

    test("returns undefined if no exe is found", () => {
      assert.equal(findWindowsInstallerAsset([]), undefined);
      assert.equal(findWindowsInstallerAsset([{ name: "foo.zip", browser_download_url: "url" }]), undefined);
    });
  });

  describe("checkGitHubReleaseUpdate", () => {
    test("returns update info when newer release is found", async () => {
      const release: GitHubReleaseResponse = {
        tag_name: "v0.1.4",
        name: "OMP Studio 0.1.4",
        body: "Bug fixes and improvements",
        html_url: "https://github.com/release/v0.1.4",
        published_at: "2026-09-04T12:00:00Z",
        assets: [
          { name: "OMP-Studio-Setup-0.1.4.exe", browser_download_url: "https://github.com/setup.exe", size: 45000000 },
        ],
      };

      const mockFetcher = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => release,
        }) as Response;

      const result = await checkGitHubReleaseUpdate({
        currentVersion: "0.1.3",
        fetcher: mockFetcher as any,
      });

      assert.ok(result !== null);
      assert.equal(result.available, true);
      assert.equal(result.version, "0.1.4");
      assert.equal(result.assetName, "OMP-Studio-Setup-0.1.4.exe");
      assert.equal(result.downloadUrl, "https://github.com/setup.exe");
      assert.equal(result.releaseNotes, "Bug fixes and improvements");
    });

    test("returns available false when current version is >= latest release", async () => {
      const release: GitHubReleaseResponse = {
        tag_name: "v0.1.3",
        assets: [
          { name: "Setup.exe", browser_download_url: "https://example.com/Setup.exe" },
        ],
      };

      const mockFetcher = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => release,
        }) as Response;

      const result = await checkGitHubReleaseUpdate({
        currentVersion: "0.1.3",
        fetcher: mockFetcher as any,
      });

      assert.ok(result !== null);
      assert.equal(result.available, false);
      assert.equal(result.version, "0.1.3");
    });

    test("throws on network error", async () => {
      const mockFetcher = async () => {
        throw new Error("Network error");
      };

      await assert.rejects(
        () => checkGitHubReleaseUpdate({ currentVersion: "0.1.3", fetcher: mockFetcher as any }),
        /Network error/,
      );
    });
  });

  describe("downloadInstallerFile", () => {
    test("downloads stream to destination and returns file path", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "omp-installer-dl-"));
      try {
        const chunk1 = Buffer.from("Hello ");
        const chunk2 = Buffer.from("World!");

        const mockFetcher = async () => {
          const stream = Readable.toWeb(Readable.from([chunk1, chunk2]));
          return {
            ok: true,
            status: 200,
            body: stream,
          } as any;
        };

        const downloadedPath = await downloadInstallerFile({
          url: "https://example.com/OMP-Setup.exe",
          targetDirectory: tempDir,
          fetcher: mockFetcher as any,
        });

        assert.ok(downloadedPath.endsWith("OMP-Setup.exe"));
        const downloaded = await readFile(downloadedPath, "utf8");
        assert.equal(downloaded, "Hello World!");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("registerChromeAppUpdateIpc", () => {
    test("wires check, download, and install handlers", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "omp-app-update-ipc-"));
      try {
        const ipc = new FakeIpcMain();
        let openPathCalledWith = "";
        let quitCalled = false;

        const release: GitHubReleaseResponse = {
          tag_name: "v0.1.4",
          body: "notes",
          assets: [
            { name: "Setup.exe", browser_download_url: "https://example.com/Setup.exe", size: 12 },
          ],
        };

        const mockFetcher = async (url: string) => {
          if (url.endsWith("Setup.exe")) {
            return {
              ok: true,
              status: 200,
              body: Readable.toWeb(Readable.from([Buffer.from("dummy-binary")])),
            } as any;
          }
          return {
            ok: true,
            status: 200,
            json: async () => release,
          } as any;
        };

        const handle = registerChromeAppUpdateIpc({
          ipcMain: ipc as any,
          isTrustedSender: () => true,
          currentVersion: "0.1.3",
          updatesDirectory: tempDir,
          openPath: async (p) => {
            openPathCalledWith = p;
            return "";
          },
          quitApp: () => {
            quitCalled = true;
          },
          fetcher: mockFetcher as any,
        });

        // 1. check
        const checkRes = (await ipc.invoke(CHROME_APP_UPDATE_CHANNELS.check, {
          isDestroyed: () => false,
        })) as AppUpdateInfo;
        assert.equal(checkRes.available, true);
        assert.equal(checkRes.version, "0.1.4");

        // 2. download
        const dlRes = await ipc.invoke(
          CHROME_APP_UPDATE_CHANNELS.download,
          { isDestroyed: () => false, send: () => {} },
          { url: "https://example.com/Setup.exe" },
        );
        assert.equal(dlRes.ok, true);
        assert.ok(dlRes.filePath.endsWith("Setup.exe"));

        // 3. install (openPath + quit)
        const instRes = await ipc.invoke(
          CHROME_APP_UPDATE_CHANNELS.install,
          { isDestroyed: () => false },
          { filePath: dlRes.filePath },
        );
        assert.equal(instRes.ok, true);
        assert.equal(openPathCalledWith, dlRes.filePath);

        handle.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    test("rejects untrusted sender", async () => {
      const ipc = new FakeIpcMain();
      const handle = registerChromeAppUpdateIpc({
        ipcMain: ipc as any,
        isTrustedSender: () => false,
        currentVersion: "0.1.3",
        updatesDirectory: "dummy",
        openPath: () => "",
      });

      const checkRes = await ipc.invoke(CHROME_APP_UPDATE_CHANNELS.check, {
        isDestroyed: () => false,
      });
      assert.equal(checkRes, null);

      const dlRes = await ipc.invoke(
        CHROME_APP_UPDATE_CHANNELS.download,
        { isDestroyed: () => false },
        { url: "https://example.com/Setup.exe" },
      );
      assert.equal(dlRes.ok, false);
      assert.equal(dlRes.message, "Untrusted sender");

      handle.dispose();
    });
  });
});
