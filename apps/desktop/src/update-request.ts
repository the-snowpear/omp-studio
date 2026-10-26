import { setTimeout as sleep } from "node:timers/promises";
import type { HostLog } from "./host-log.js";
import { applyMirror } from "./update-index.js";

export type UpdateRequestLog = Pick<HostLog, "write">;
export interface UpdateRequestPolicy {
  responseTimeoutMs: number;
  idleTimeoutMs: number;
  retryDelaysMs: readonly [number, number];
}
const DEFAULT_POLICY: UpdateRequestPolicy = {
  responseTimeoutMs: 15_000, idleTimeoutMs: 30_000, retryDelaysMs: [1_000, 3_000],
};
export interface UpdateRequestOptions {
  url: string;
  mirror?: string | undefined;
  signal: AbortSignal;
  fetcher?: typeof fetch | undefined;
  log?: UpdateRequestLog | undefined;
  stage: "catalog" | "manifest" | "artifact";
  acceptNotModified?: boolean;
  /** Short deadlines in tests; production uses DEFAULT_POLICY. */
  requestPolicy?: Partial<UpdateRequestPolicy> | undefined;
}
export interface UpdateRequestAttempt {
  readonly url: string;
  readonly signal: AbortSignal;
  request(headers?: NonNullable<Parameters<typeof fetch>[1]>["headers"]): Promise<Response>;
  read(reader: ReadableStreamDefaultReader<Uint8Array>): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>;
}

export class UpdateTransportError extends Error {}
class UpdateHttpError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  constructor(readonly status: number, host: string, headers: Headers) {
    const retryAfter = headers.get("retry-after");
    const reset = headers.get("x-ratelimit-remaining") === "0" ? headers.get("x-ratelimit-reset") : null;
    const retryAt = retryAfter === null ? (reset === null ? undefined : Number(reset) * 1000)
      : /^\d+$/u.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
    const limited = status === 429 || (status === 403 && (reset !== null || retryAfter !== null));
    const next = limited && retryAt !== undefined && Number.isFinite(retryAt) ? `；可在 ${new Date(retryAt).toISOString()} 后重试` : "";
    super(`更新请求 HTTP ${status}（${host}）${limited ? "，请求受限" : ""}${next}`);
    this.retryable = status === 408 || status >= 500 || limited;
    this.retryAfterMs = limited && retryAt !== undefined && Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
  }
}

export function withUpdateSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      void promise.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** One update request, including stream consumption, has at most three attempts. */
export async function withUpdateRequest<T>(input: UpdateRequestOptions, operation: (attempt: UpdateRequestAttempt) => Promise<T>): Promise<T> {
  const policy = { ...DEFAULT_POLICY, ...input.requestPolicy };
  const mirrorUrl = applyMirror(input.mirror ?? "", input.url);
  let url = mirrorUrl;
  for (let index = 0; index < 3; index++) {
    input.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const host = new URL(url).hostname;
    let response: Response | undefined;
    try {
      return await operation({
        url, signal,
        async request(headers) {
          const timer = setTimeout(() => controller.abort(new UpdateTransportError("更新请求首响应超时")), policy.responseTimeoutMs);
          try {
            try { response = await withUpdateSignal((input.fetcher ?? fetch)(url, { ...(headers === undefined ? {} : { headers }), signal }), signal); }
            catch (error) {
              signal.throwIfAborted();
              throw new UpdateTransportError("更新请求连接中断", { cause: error });
            }
            input.log?.write("info", "update.request", `stage=${input.stage} host=${host} attempt=${index + 1} status=${response.status}`);
            if (!response.ok && !(input.acceptNotModified && response.status === 304)) throw new UpdateHttpError(response.status, host, response.headers);
            return response;
          } finally { clearTimeout(timer); }
        },
        async read(reader) {
          const timer = setTimeout(() => controller.abort(new UpdateTransportError("更新下载长时间没有进展")), policy.idleTimeoutMs);
          try {
            try { return await withUpdateSignal(reader.read(), signal); }
            catch (error) {
              signal.throwIfAborted();
              throw new UpdateTransportError("更新响应传输中断", { cause: error });
            }
          } finally { clearTimeout(timer); }
        },
      });
    } catch (error) {
      input.signal.throwIfAborted();
      const fallback = url !== input.url;
      const retryable = error instanceof UpdateTransportError || (error instanceof UpdateHttpError && error.retryable);
      const reason = error instanceof UpdateHttpError ? `http-${error.status}` : retryable ? "transport" : "content";
      if (index === 2 || (!fallback && !retryable)) {
        input.log?.write("warn", "update.request.failed", `stage=${input.stage} host=${host} attempt=${index + 1} reason=${reason}`);
        throw error;
      }
      // A mirror may reject GitHub API or Range requests. Start again at the
      // original URL, rather than reusing a possibly expired CDN redirect.
      if (fallback) {
        input.log?.write("warn", "update.request.fallback", `stage=${input.stage} host=${host} target=${new URL(input.url).hostname} attempt=${index + 1} reason=${reason}`);
        url = input.url;
      } else {
        const delay = Math.max(policy.retryDelaysMs[index] ?? 0, error instanceof UpdateHttpError ? error.retryAfterMs : 0);
        if (delay > 60_000) throw error;
        input.log?.write("warn", "update.request.retry", `stage=${input.stage} host=${host} attempt=${index + 1} delayMs=${delay} reason=${reason}`);
        try { await sleep(delay, undefined, { signal: input.signal }); }
        catch (waitError) { input.signal.throwIfAborted(); throw waitError; }
      }
    } finally {
      controller.abort();
      void response?.body?.cancel().catch(() => {});
    }
  }
  throw new Error("Update request attempts exhausted");
}
