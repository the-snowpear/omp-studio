import assert from "node:assert/strict";
import test from "node:test";

import { containsPrivateMaterial } from "./p5-secret-scan.mjs";

test("P5 secret scan permits distributable public keys and certificates", () => {
  assert.equal(containsPrivateMaterial("-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----"), false);
  assert.equal(containsPrivateMaterial("-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----"), false);
});

test("P5 secret scan rejects private key material", () => {
  for (const header of [
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN SSH2 ENCRYPTED PRIVATE KEY BLOCK-----",
  ]) {
    assert.equal(containsPrivateMaterial(`${header}\nsecret`), true, header);
  }
  assert.equal(containsPrivateMaterial('{"privateKey":"secret"}'), true);
});
