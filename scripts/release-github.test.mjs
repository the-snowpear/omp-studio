import assert from "node:assert/strict";
import { test } from "node:test";
import { readGitHubApi } from "./release-github.mjs";

function transportFailure(message) {
  const error = new Error("GitHub request failed");
  error.stderr = Buffer.from(message);
  return error;
}

test("a GitHub EOF retries the same read and returns the complete response", async () => {
  const bytes = Buffer.from('{"manifest":"complete signed catalog"}');
  const calls = [], delays = [];
  const result = await readGitHubApi(["-H", "Accept: application/octet-stream", "repos/owner/repo/releases/assets/42"], {
    maxBuffer: 1024 * 1024,
    execute(command, args, options) {
      calls.push({ command, args, options });
      if (calls.length === 1) throw transportFailure('Get "https://api.github.com/...": EOF');
      return bytes;
    },
    sleep: async milliseconds => { delays.push(milliseconds); },
  });
  assert.deepEqual(result, bytes);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0].args.slice(0, 3), ["api", "--method", "GET"]);
  assert.equal(calls[0].options.timeout, 60_000);
  assert.deepEqual(delays, [1000]);
});

test("persistent GitHub connection failures stop after three reads", async () => {
  let calls = 0;
  const delays = [], failure = transportFailure("unexpected EOF");
  await assert.rejects(readGitHubApi(["repos/owner/repo/releases"], {
    execute() { calls++; throw failure; },
    sleep: async milliseconds => { delays.push(milliseconds); },
  }), error => error === failure);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test("GitHub permission failures are not retried or hidden", async () => {
  let calls = 0;
  const failure = transportFailure("HTTP 403: Resource not accessible by integration");
  await assert.rejects(readGitHubApi(["repos/owner/repo/releases"], {
    execute() { calls++; throw failure; },
    sleep: async () => { assert.fail("Permission failures must not wait for retries"); },
  }), error => error === failure);
  assert.equal(calls, 1);
});
