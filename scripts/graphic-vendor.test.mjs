import assert from "node:assert/strict";
import { test } from "node:test";
import { graphicVendorPlugin } from "../apps/renderer/graphic-vendor-plugin.ts";

test("ships the minified viewer and its components without duplicate distributions", async () => {
  const files = [];
  const generate = graphicVendorPlugin().generateBundle;
  await generate.call({ emitFile: asset => files.push(asset.fileName) });
  assert.ok(files.includes("graphics-xite/x_ite.min.mjs"));
  assert.ok(files.includes("graphics-xite/assets/components/TextComponent.min.js"));
  assert.ok(!files.includes("graphics-xite/x_ite.mjs"));
  assert.ok(!files.includes("graphics-xite/x_ite.min.js"));
  assert.ok(files.some(file => file.startsWith("graphics-xite/LICENSES/")));
  assert.ok(!files.some(file => file.startsWith("graphics-xite/assets/components/") && file.endsWith(".js") && !file.endsWith(".min.js")));
});
