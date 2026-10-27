// Executable architecture rules. These encode the constraints AGENTS.md asks
// reviewers to remember, so a wrong import fails in seconds instead of surviving
// review. They run in `npm run check` before anything is compiled.
//
// If a rule becomes intentionally wrong, change the table or the allowance in the
// same commit as the code — that diff is the decision record.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = "@omp-studio/";
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

// Internal dependency direction. A package may only depend on what its row allows;
// units without a row (testkit, desktop, renderer) are not constrained here.
const ALLOWED_INTERNAL_DEPS = {
  "studio-protocol": [],
  "client-contract": ["studio-protocol"],
  client: ["client-contract", "studio-protocol"],
  "transport-desktop": ["client-contract"],
  "transport-web": ["client-contract"],
  platform: [],
  "platform-win32": ["platform"],
  "platform-darwin": ["platform"],
  "runtime-installer": ["studio-protocol"],
  "studio-host": ["runtime-installer", "studio-protocol"],
  "host-client-api": ["client-contract", "studio-host", "studio-protocol"],
};

function readUnits() {
  const found = [];
  for (const parent of ["packages", "apps"]) {
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (!pkg.name?.startsWith(scope)) continue;
      const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      found.push({
        key: pkg.name.slice(scope.length),
        dir,
        relativeDir: `${parent}/${name}`,
        internal: declared.filter(dep => dep.startsWith(scope)).map(dep => dep.slice(scope.length)),
        declared,
      });
    }
  }
  return found.sort((left, right) => left.key.localeCompare(right.key));
}

const units = readUnits();
const byKey = new Map(units.map(unit => [unit.key, unit]));

// Only implementation sources: tests and fixtures may use whatever they need.
function sourceFiles(dir) {
  const files = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const IMPORT = /(?:^\s*import\s+(?:type\s+)?[^"']*?from\s*|^\s*export\s+(?:type\s+)?[^"']*?from\s*|^\s*import\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/gm;

function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  for (const match of text.matchAll(IMPORT)) found.push(match[1]);
  return found;
}

const name = file => relative(root, file).split(sep).join("/");

test("workspace units form no dependency cycle", () => {
  const cycles = [];
  const done = new Set();
  const stack = [];
  const onStack = new Set();
  const visit = key => {
    if (done.has(key)) return;
    stack.push(key);
    onStack.add(key);
    for (const dep of byKey.get(key)?.internal ?? []) {
      if (!byKey.has(dep)) continue;
      if (onStack.has(dep)) cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(" -> "));
      else visit(dep);
    }
    stack.pop();
    onStack.delete(key);
    done.add(key);
  };
  for (const unit of units) visit(unit.key);
  assert.deepEqual(cycles, [], "workspace dependency cycle");
});

test("packages keep the declared one-way layering", () => {
  const violations = [];
  for (const unit of units) {
    const allowed = ALLOWED_INTERNAL_DEPS[unit.key];
    if (!allowed) continue;
    for (const dep of unit.internal) {
      if (allowed.includes(dep)) continue;
      violations.push(`${unit.key} must not depend on ${dep} (allowed: ${allowed.join(", ") || "none"})`);
    }
  }
  assert.deepEqual(violations, [], "layering violation");
});

test("only the desktop app depends on electron", () => {
  const violations = [];
  for (const unit of units) {
    if (unit.declared.includes("electron") && unit.key !== "desktop") {
      violations.push(`${unit.key} declares electron`);
    }
    for (const file of sourceFiles(join(unit.dir, "src"))) {
      for (const specifier of importsOf(file)) {
        if (specifier === "electron" && unit.key !== "desktop") violations.push(`${name(file)} imports electron`);
      }
    }
  }
  assert.deepEqual(violations, [], "electron leaked outside the desktop app");
});

test("only the renderer depends on react", () => {
  const violations = [];
  for (const unit of units) {
    const react = unit.declared.filter(dep => dep === "react" || dep === "react-dom" || dep.startsWith("@testing-library/"));
    if (react.length && unit.key !== "renderer") violations.push(`${unit.key} declares ${react.join(", ")}`);
  }
  assert.deepEqual(violations, [], "react leaked into a non-renderer unit");
});

test("renderer sources do not reach for node or electron", () => {
  const violations = [];
  for (const file of sourceFiles(join(root, "apps", "renderer", "src"))) {
    for (const specifier of importsOf(file)) {
      const isBuiltin = specifier.startsWith("node:") || builtins.has(specifier.split("/")[0]);
      if (isBuiltin || specifier === "electron") violations.push(`${name(file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], "renderer must go through the preload bridge");
});

test("host packages never import the test fixtures", () => {
  const violations = [];
  for (const unit of units) {
    if (unit.key === "testkit" || unit.key === "desktop" || unit.key === "renderer") continue;
    for (const file of sourceFiles(join(unit.dir, "src"))) {
      for (const specifier of importsOf(file)) {
        if (specifier === `${scope}testkit`) violations.push(`${name(file)} imports testkit`);
      }
    }
  }
  assert.deepEqual(violations, [], "demo data belongs in the renderer preview layer");
});

test("the preview switch is defined once", () => {
  const definitions = [];
  const readers = [];
  for (const file of sourceFiles(join(root, "apps"))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("PREVIEW_MODE_SWITCH_ENABLED")) continue;
    if (/export\s+const\s+PREVIEW_MODE_SWITCH_ENABLED\s*=/.test(text)) definitions.push(name(file));
    else readers.push(name(file));
  }
  assert.deepEqual(definitions, ["apps/renderer/src/preview/mode.ts"], "preview switch must have a single definition");
  const strayReaders = readers.filter(file => !file.startsWith("apps/renderer/src/preview/"));
  assert.deepEqual(strayReaders, [], "preview switch is only read by the preview layer");
});
