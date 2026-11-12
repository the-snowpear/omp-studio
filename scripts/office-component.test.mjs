import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { signOfficeManifest, OFFICE_PLATFORMS } from "./office-component.mjs";
import { verifyOfficeComponent } from "../apps/desktop/dist/src/office-component-manifest.js";

test("Office signing uses the same approved release environment as Runtime signing", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/office-component.yml", import.meta.url), "utf8"));
  assert.equal(workflow.jobs.build.environment, "release");
});

test("published Office component manifests verify with the desktop installer on each supported platform", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = { test: publicKey.export({ type: "spki", format: "pem" }) };
  for (const [platform, definition] of Object.entries(OFFICE_PLATFORMS)) {
    const manifest = { schema: 1, component: "office-preview", version: "26.8.2", engineVersion: "26.8.2", platform, entrypoint: definition.entrypoint, archive: { url: "https://example.org/office.zip", sha256: "a".repeat(64), bytes: 123 }, sourceUrl: "https://www.libreoffice.org", license: "MPL-2.0" };
    const envelope = signOfficeManifest(manifest, privateKey, "test");
    assert.deepEqual(verifyOfficeComponent(envelope, keys, platform).manifest, manifest);
  }
});
