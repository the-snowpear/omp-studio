import assert from "node:assert/strict";
import { test } from "node:test";
import { Win32PrivateEndpoint, type Win32EndpointProviders } from "../src/index.js";

const PROFILE = "C:\\Users\\operator\\AppData\\Local\\omp-studio\\profiles\\default";
const CURRENT_USER_SID = "S-1-5-21-3623811015-3361044348-30300820-1001";
/** 32 hex characters with 16 distinct symbols = exactly 128 bits of entropy. */
const FRESH_AUTHORITY = "0f9a7e3c5b1d8a2e6c4f9b0d7e3a5c18";

interface FakeProviders {
  providers: Win32EndpointProviders;
  calls: string[];
  reserved: Set<string>;
}

function fakeProviders(overrides: Partial<Win32EndpointProviders> = {}): FakeProviders {
  const calls: string[] = [];
  const reserved = new Set<string>();
  const providers: Win32EndpointProviders = {
    currentUserSid: () => CURRENT_USER_SID,
    generateEndpointAuthority: () => FRESH_AUTHORITY,
    reserveEndpoint: (authority) => {
      calls.push(`reserve:${authority}`);
      if (reserved.has(authority)) {
        return false;
      }
      reserved.add(authority);
      return true;
    },
    applyOwnerOnlyAcl: async (authority, sid) => {
      calls.push(`acl:${sid}:${authority}`);
    },
    releaseEndpoint: async (authority) => {
      calls.push(`release:${authority}`);
      reserved.delete(authority);
    },
  };
  return { providers: Object.assign(providers, overrides), calls, reserved };
}

test("Win32PrivateEndpoint rejects providers missing required native methods", () => {
  assert.throws(
    () => new Win32PrivateEndpoint({ currentUserSid: () => CURRENT_USER_SID } as unknown as Win32EndpointProviders),
    /missing required method/u,
  );
});

test("creates a current-user-only endpoint on the injected non-admin path", async () => {
  const { providers, calls, reserved } = fakeProviders();
  const seam = new Win32PrivateEndpoint(providers);
  const lease = await seam.createCurrentUserOnly(PROFILE);
  assert.equal(lease.endpoint.kind, "named-pipe");
  assert.equal(lease.endpoint.authority, FRESH_AUTHORITY);
  assert.deepEqual(calls, [`reserve:${FRESH_AUTHORITY}`, `acl:${CURRENT_USER_SID}:${FRESH_AUTHORITY}`]);
  assert.equal(reserved.has(FRESH_AUTHORITY), true);
  await lease.release();
  assert.equal(reserved.has(FRESH_AUTHORITY), false);
});

test("lease release is idempotent", async () => {
  const { providers, calls } = fakeProviders();
  const seam = new Win32PrivateEndpoint(providers);
  const lease = await seam.createCurrentUserOnly(PROFILE);
  await lease.release();
  await lease.release();
  assert.deepEqual(calls, [
    `reserve:${FRESH_AUTHORITY}`,
    `acl:${CURRENT_USER_SID}:${FRESH_AUTHORITY}`,
    `release:${FRESH_AUTHORITY}`,
  ]);
});

test("collisions retry with fresh authorities within the bounded budget", async () => {
  const takenFirst = "0123456789abcdef0123456789abcdef";
  const takenSecond = "fedcba9876543210fedcba9876543210";
  const authorities = [takenFirst, takenSecond, FRESH_AUTHORITY];
  let generated = 0;
  const { providers, calls, reserved } = fakeProviders({
    generateEndpointAuthority: () => authorities[generated++] ?? FRESH_AUTHORITY,
  });
  reserved.add(takenFirst).add(takenSecond);
  const seam = new Win32PrivateEndpoint(providers);
  const lease = await seam.createCurrentUserOnly(PROFILE);
  assert.equal(lease.endpoint.authority, FRESH_AUTHORITY);
  assert.equal(generated, 3);
  assert.deepEqual(calls, [
    `reserve:${takenFirst}`,
    `reserve:${takenSecond}`,
    `reserve:${FRESH_AUTHORITY}`,
    `acl:${CURRENT_USER_SID}:${FRESH_AUTHORITY}`,
  ]);
  await lease.release();
});

test("repeated collisions fail closed after the bounded budget", async () => {
  // Override the default recorder-backed reserveEndpoint AFTER construction:
  // a bare `() => false` override would replace the recording implementation
  // and leave `calls` empty, silently untesting the retry loop.
  const fake = fakeProviders();
  fake.providers.reserveEndpoint = (authority) => {
    fake.calls.push(`reserve:${authority}`);
    return false;
  };
  const { providers, calls } = fake;
  const seam = new Win32PrivateEndpoint(providers);
  await assert.rejects(seam.createCurrentUserOnly(PROFILE), /repeated collisions/u);
  // Bounded: exactly the retry budget of attempts, never an infinite loop.
  const reserveCalls = calls.filter((call) => call.startsWith("reserve:"));
  assert.equal(reserveCalls.length, 5);
  // Fail-closed: every attempt collided, so no ACL was ever applied.
  assert.equal(calls.some((call) => call.startsWith("acl:")), false);
});

test("ACL failure releases the reservation and fails closed", async () => {
  const { providers, calls, reserved } = fakeProviders({
    applyOwnerOnlyAcl: async () => {
      throw new Error("owner-only ACL denied");
    },
  });
  const seam = new Win32PrivateEndpoint(providers);
  await assert.rejects(seam.createCurrentUserOnly(PROFILE), /owner-only ACL denied/u);
  assert.equal(reserved.has(FRESH_AUTHORITY), false);
  assert.deepEqual(calls, [`reserve:${FRESH_AUTHORITY}`, `release:${FRESH_AUTHORITY}`]);
});

test("rejects an empty or malformed current-user SID before reserving", async () => {
  const invalid = ["", "S-1", "S-1-5", "not-a-sid", "S-1-5-21-...-1001"];
  for (const bad of invalid) {
    const { providers, calls } = fakeProviders({ currentUserSid: () => bad });
    const seam = new Win32PrivateEndpoint(providers);
    await assert.rejects(seam.createCurrentUserOnly(PROFILE), /SID/u, `accepted SID ${bad}`);
    assert.deepEqual(calls, [], `touched providers for SID ${bad}`);
  }
});

test("rejects a low-entropy authority before reservation", async () => {
  const lowEntropy = ["abc", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0123456789abcdef"];
  for (const authority of lowEntropy) {
    const { providers, calls, reserved } = fakeProviders({
      generateEndpointAuthority: () => authority,
    });
    const seam = new Win32PrivateEndpoint(providers);
    await assert.rejects(seam.createCurrentUserOnly(PROFILE), /entropy/u, `accepted ${authority}`);
    assert.equal(reserved.size, 0, `reserved low-entropy authority ${authority}`);
    assert.deepEqual(calls, [], `touched providers for low-entropy authority ${authority}`);
  }
});

test("the endpoint carries only the opaque authority, never paths or identity", async () => {
  const { providers } = fakeProviders();
  const seam = new Win32PrivateEndpoint(providers);
  const lease = await seam.createCurrentUserOnly(PROFILE);
  const endpoint = lease.endpoint;
  assert.deepEqual(Object.keys(endpoint).sort(), ["authority", "kind"]);
  assert.equal(endpoint.authority.includes(PROFILE), false);
  assert.equal(endpoint.authority.includes(CURRENT_USER_SID), false);
  assert.equal(endpoint.authority.includes("pipe"), false);
  await lease.release();
});

test("rejects an empty profile directory", async () => {
  const { providers, calls } = fakeProviders();
  const seam = new Win32PrivateEndpoint(providers);
  await assert.rejects(seam.createCurrentUserOnly(""), /non-empty string/u);
  assert.deepEqual(calls, []);
});
