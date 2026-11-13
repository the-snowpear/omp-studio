import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

function interruptedRead(error) {
  const detail = error.stderr?.toString() ?? error.message ?? "";
  // Authentication and missing resources need a fix, not repeated requests.
  if (/\bHTTP\s+4\d\d\b/i.test(detail)) return false;
  return error.code === "ETIMEDOUT" || /\b(?:EOF|ECONNRESET|EAI_AGAIN|ETIMEDOUT)\b|TLS handshake timeout|i\/o timeout|\bHTTP\s+(?:502|503|504)\b/i.test(detail);
}

/** Retry only read-only GitHub transport failures; callers still verify every returned byte. */
export async function readGitHubApi(args, options = {}) {
  const { execute = execFileSync, sleep = setTimeout, ...executionOptions } = options;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execute("gh", ["api", "--method", "GET", ...args], {
        timeout: 60_000,
        ...executionOptions,
      });
    } catch (error) {
      if (attempt === 3 || !interruptedRead(error)) throw error;
      console.warn(`GitHub read interrupted; retry ${attempt + 1}/3`);
      await sleep(attempt * 1_000);
    }
  }
}
