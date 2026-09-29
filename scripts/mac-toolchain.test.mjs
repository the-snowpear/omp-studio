import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_BUN_VERSION, assertMacToolchain, compareVersions, macToolchainProblems } from "./mac-toolchain.mjs";

function runner(outputs) {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args].join(" "));
    const key = [file, ...args].join(" ");
    if (!(key in outputs)) throw new Error(`unexpected ${key}`);
    const value = outputs[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return { run, calls };
}

const READY = {
  "/usr/bin/xcode-select -p": "/Library/Developer/CommandLineTools\n",
  "/usr/bin/xcrun --find clang": "/Library/Developer/CommandLineTools/usr/bin/clang\n",
  "rustc -vV": "rustc 1.90.0\nhost: aarch64-apple-darwin\n",
};

test("version comparison handles prefixes and missing parts", () => {
  assert.equal(compareVersions("1.4.2", MIN_BUN_VERSION), 0);
  assert.equal(compareVersions("v1.10.0", "1.4.2"), 1);
  assert.equal(compareVersions("1.3.14", "1.4.2"), -1);
  assert.equal(compareVersions("1.4", "1.4.0"), 0);
});

test("a ready Apple Silicon toolchain reports no problems", () => {
  const { run } = runner(READY);
  assert.deepEqual(macToolchainProblems({ rust: true, bunVersion: "1.4.2", arch: "arm64", translated: false, run }), []);
});

test("missing Command Line Tools never touches the shims that pop the install dialog", () => {
  const { run, calls } = runner({ ...READY, "/usr/bin/xcode-select -p": new Error("unable to get active developer directory") });
  const problems = macToolchainProblems({ arch: "arm64", translated: false, run });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /xcode-select --install/u);
  assert.deepEqual(calls, ["/usr/bin/xcode-select -p"]);
});

test("every problem is reported at once", () => {
  const { run } = runner({ ...READY, "rustc -vV": "host: x86_64-apple-darwin\n" });
  const problems = macToolchainProblems({ rust: true, bunVersion: "1.3.14", arch: "x64", translated: true, run });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /native arm64/u);
  assert.match(problems[1], /Bun 1\.4\.2 or newer/u);
  assert.match(problems[2], /aarch64-apple-darwin; rustc host is x86_64-apple-darwin/u);
  assert.throws(() => assertMacToolchain({ rust: true, bunVersion: "1.3.14", arch: "x64", translated: true, run }), /toolchain is not ready:\n- /u);
});

test("Rust is only required when asked for", () => {
  const { run } = runner({ ...READY, "rustc -vV": new Error("rustc: command not found") });
  assert.deepEqual(macToolchainProblems({ arch: "arm64", translated: false, run }), []);
  assert.match(macToolchainProblems({ rust: true, arch: "arm64", translated: false, run })[0], /rustup/u);
});
