import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resourceHandle,
  runtimeProcessHandle,
  type ResourceHandle,
  type RuntimeProcessHandle,
} from "@omp-studio/platform";
import {
  Win32PlatformPort,
  Win32RuntimeContainment,
  type Win32PlatformServices,
} from "../src/index.js";

interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

function recordingServices(
  overrides: Partial<Win32PlatformServices> = {},
  appDataDirectory = "C:\\Users\\operator\\AppData\\Local\\omp-studio",
): { services: Win32PlatformServices; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const services: Win32PlatformServices = {
    appDataDirectory: async () => {
      record("appDataDirectory");
      return appDataDirectory;
    },
    createCurrentUserOnlyEndpoint: async (profileDirectory) => {
      record("createCurrentUserOnlyEndpoint", profileDirectory);
      return "endpoint-authority-7f3a9c";
    },
    attachProcess: async (handle) => {
      record("attach", handle);
    },
    requestProcessStop: async (handle) => {
      record("requestStop", handle);
    },
    forceProcessStop: async (handle) => {
      record("forceStop", handle);
    },
    releaseProcess: async (handle) => {
      record("release", handle);
    },
    revealInExplorer: async (path) => {
      record("revealInExplorer", path);
    },
    openExternal: async (url) => {
      record("openExternal", url);
    },
  };
  return { services: Object.assign(services, overrides), calls };
}

test("Win32PlatformPort reports the win32 platform", () => {
  const port = new Win32PlatformPort(recordingServices().services);
  assert.equal(port.platform, "win32");
});

test("runtimeExecutableName is the Windows runtime filename", () => {
  const port = new Win32PlatformPort(recordingServices().services);
  assert.equal(port.runtimeExecutableName(), "omp.exe");
});

test("Win32PlatformPort rejects services missing required native methods", () => {
  assert.throws(
    () => new Win32PlatformPort({ appDataDirectory: async () => "C:\\x" } as unknown as Win32PlatformServices),
    /missing required method/u,
  );
});

test("Win32RuntimeContainment rejects a controller missing required methods", () => {
  assert.throws(() => new Win32RuntimeContainment({} as never), /missing required method/u);
});

test("appDataDirectory returns the validated service-supplied directory", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  assert.equal(await port.appDataDirectory(), "C:\\Users\\operator\\AppData\\Local\\omp-studio");
  assert.deepEqual(calls, [{ method: "appDataDirectory", args: [] }]);
});

test("appDataDirectory rejects relative, drive-relative, and empty directories", async () => {
  for (const bad of ["AppData\\Local\\omp-studio", "omp-studio", "C:relative", ""]) {
    const { services } = recordingServices({}, bad);
    const port = new Win32PlatformPort(services);
    await assert.rejects(port.appDataDirectory(), /absolute Windows path|non-empty string/u);
  }
});

test("appDataDirectory uses the current-user directory without assuming elevation", async () => {
  const { services, calls } = recordingServices({}, "C:\\Users\\测试 用户\\AppData\\Local\\OMP Studio");
  const port = new Win32PlatformPort(services);
  assert.equal(await port.appDataDirectory(), "C:\\Users\\测试 用户\\AppData\\Local\\OMP Studio");
  // Only the directory lookup happens: no identity, privilege, or elevation probes.
  assert.deepEqual(calls, [{ method: "appDataDirectory", args: [] }]);
});

test("createPrivateEndpoint wraps the service authority as an opaque named-pipe endpoint", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  const profile = "C:\\Users\\operator\\AppData\\Local\\omp-studio\\profiles\\default";
  const endpoint = await port.createPrivateEndpoint(profile);
  assert.equal(endpoint.kind, "named-pipe");
  assert.equal(endpoint.authority, "endpoint-authority-7f3a9c");
  assert.notEqual(endpoint.authority, profile);
  assert.deepEqual(calls, [{ method: "createCurrentUserOnlyEndpoint", args: [profile] }]);
});

test("createPrivateEndpoint passes a Unicode/space profile directory through unchanged", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  const profile = "C:\\Users\\测试 用户\\AppData\\Local\\OMP Studio\\profiles\\我的 工作区";
  const endpoint = await port.createPrivateEndpoint(profile);
  assert.equal(endpoint.kind, "named-pipe");
  assert.deepEqual(calls, [{ method: "createCurrentUserOnlyEndpoint", args: [profile] }]);
});

test("createPrivateEndpoint rejects an empty profile directory", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  await assert.rejects(port.createPrivateEndpoint(""), /non-empty string/u);
  assert.deepEqual(calls, []);
});

test("createPrivateEndpoint rejects an empty opaque authority from the service", async () => {
  const { services } = recordingServices({ createCurrentUserOnlyEndpoint: async () => "" });
  const port = new Win32PlatformPort(services);
  await assert.rejects(port.createPrivateEndpoint("C:\\Users\\operator\\AppData\\Local\\omp-studio"), /non-empty string/u);
});

test("containment maps opaque handles to native controller calls in order", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  const containment = port.createProcessContainment();
  const handle = runtimeProcessHandle("runtime-process-1");
  await containment.attach(handle);
  await containment.requestStop(handle);
  await containment.forceStop(handle);
  await containment.release(handle);
  assert.deepEqual(calls, [
    { method: "attach", args: ["runtime-process-1"] },
    { method: "requestStop", args: ["runtime-process-1"] },
    { method: "forceStop", args: ["runtime-process-1"] },
    { method: "release", args: ["runtime-process-1"] },
  ]);
});

test("containment rejects control of a handle that was never attached", async () => {
  const { services, calls } = recordingServices();
  const containment = new Win32RuntimeContainment(services);
  const handle = runtimeProcessHandle("runtime-process-unknown");
  await assert.rejects(containment.requestStop(handle), /not under containment/u);
  await assert.rejects(containment.forceStop(handle), /not under containment/u);
  await assert.rejects(containment.release(handle), /not under containment/u);
  assert.deepEqual(calls, []);
});

test("containment rejects control of a released handle", async () => {
  const { services, calls } = recordingServices();
  const containment = new Win32RuntimeContainment(services);
  const handle = runtimeProcessHandle("runtime-process-1");
  await containment.attach(handle);
  await containment.release(handle);
  await assert.rejects(containment.requestStop(handle), /not under containment/u);
  await assert.rejects(containment.release(handle), /not under containment/u);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["attach", "release"],
  );
});

test("failed native release keeps the handle under containment", async () => {
  const { services, calls } = recordingServices({
    releaseProcess: async () => {
      throw new Error("native release failed");
    },
  });
  const containment = new Win32RuntimeContainment(services);
  const handle = runtimeProcessHandle("runtime-process-1");
  await containment.attach(handle);
  await assert.rejects(containment.release(handle), /native release failed/u);
  await containment.requestStop(handle);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["attach", "requestStop"],
  );
});

test("revealPath delegates the exact resource handle to the native revealer", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  const handle = resourceHandle("C:\\Users\\operator\\Documents\\report.txt");
  await port.revealPath(handle);
  assert.deepEqual(calls, [{ method: "revealInExplorer", args: ["C:\\Users\\operator\\Documents\\report.txt"] }]);
});

test("revealPath rejects an empty resource handle", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  await assert.rejects(port.revealPath("" as unknown as ResourceHandle), /non-empty string/u);
  assert.deepEqual(calls, []);
});

test("openExternal rejects unsafe URL schemes before delegation", async () => {
  const unsafe = [
    "file:///C:/Windows/System32/win.ini",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "ftp://example.com/file",
    "not a url",
    "",
  ];
  for (const url of unsafe) {
    const { services, calls } = recordingServices();
    const port = new Win32PlatformPort(services);
    await assert.rejects(port.openExternal(url), /missing scheme|disallowed scheme/u);
    assert.deepEqual(calls, [], `delegated an unsafe URL: ${url}`);
  }
});

test("openExternal delegates http, https, and mailto URLs verbatim", async () => {
  const allowed = [
    "https://example.com/studio",
    "http://127.0.0.1:8080/status",
    "mailto:support@example.com?subject=Feedback",
  ];
  for (const url of allowed) {
    const { services, calls } = recordingServices();
    const port = new Win32PlatformPort(services);
    await port.openExternal(url);
    assert.deepEqual(calls, [{ method: "openExternal", args: [url] }]);
  }
});

test("openExternal rejects a non-string URL", async () => {
  const { services, calls } = recordingServices();
  const port = new Win32PlatformPort(services);
  await assert.rejects(port.openExternal(42 as unknown as string), /missing scheme/u);
  assert.deepEqual(calls, []);
});

test("concurrent containments track handles independently", async () => {
  const { services, calls } = recordingServices();
  const first = new Win32RuntimeContainment(services);
  const second = new Win32RuntimeContainment(services);
  const handle = runtimeProcessHandle("runtime-process-1");
  await first.attach(handle);
  await second.attach(handle);
  await second.release(handle);
  await first.requestStop(handle);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["attach", "attach", "release", "requestStop"],
  );
});

test("Win32RuntimeContainment rejects a non-string handle on attach", async () => {
  const { services, calls } = recordingServices();
  const containment = new Win32RuntimeContainment(services);
  await assert.rejects(containment.attach("" as unknown as RuntimeProcessHandle), /non-empty string/u);
  assert.deepEqual(calls, []);
});
