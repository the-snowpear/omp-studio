/**
 * One-shot MCP JSON-RPC probe used by the Host capabilities page.
 *
 * Speaks newline-delimited JSON-RPC over stdio, or a single HTTP POST for
 * http/sse configs. Never returns command, URL, headers, or env values.
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { McpTransport } from "@omp-studio/client-contract";

import { redactText, sanitizeDisplayText } from "./read-models.js";

const PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 8_000;
const STDERR_CAP = 4_000;
const DETAIL_MAX = 240;
const TOOL_NAME_MAX = 80;
const MAX_TOOLS = 64;

export interface McpConnectSpec {
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpProbeOutcome {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
  readonly toolCount?: number;
  readonly logLines: readonly string[];
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown; readonly code?: unknown };
}

function safeDetail(value: string): string {
  return sanitizeDisplayText(redactText(value), DETAIL_MAX) ?? "MCP 探测失败";
}

function safeLine(value: string): string | undefined {
  return sanitizeDisplayText(redactText(value), DETAIL_MAX);
}

export async function probeMcpServer(
  spec: McpConnectSpec,
  options?: { readonly timeoutMs?: number; readonly cwd?: string },
): Promise<McpProbeOutcome> {
  const started = performance.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const tools =
      spec.transport === "stdio"
        ? await probeStdio(spec, timeoutMs, options?.cwd)
        : await probeHttp(spec, timeoutMs);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const toolCount = tools.length;
    return {
      ok: true,
      latencyMs,
      detail: safeDetail(`已连接（${toolCount} 个工具）`),
      toolCount,
      logLines: [
        `connected tools=${toolCount}`,
        ...tools.slice(0, 12).map((name) => `tool ${name}`),
      ].flatMap((line) => {
        const next = safeLine(line);
        return next === undefined ? [] : [next];
      }),
    };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const message = error instanceof Error ? error.message : "MCP 探测失败";
    const detail = safeDetail(message);
    return {
      ok: false,
      latencyMs,
      detail,
      logLines: [detail].flatMap((line) => {
        const next = safeLine(line);
        return next === undefined ? [] : [next];
      }),
    };
  }
}

async function probeStdio(spec: McpConnectSpec, timeoutMs: number, cwd?: string): Promise<string[]> {
  const command = spec.command?.trim();
  if (command === undefined || command.length === 0) {
    throw new Error("stdio 服务器未配置启动命令");
  }
  const args = [...(spec.args ?? [])];
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderrChunks: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderrChunks.join("").length >= STDERR_CAP) return;
    stderrChunks.push(chunk.slice(0, STDERR_CAP));
  });

  const session = new NdjsonSession((line) => {
    child.stdin?.write(`${line}\n`);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => session.push(chunk));
  child.on("error", () => session.fail(new Error("无法启动 MCP 进程")));
  child.on("close", (code) => {
    if (!session.done) {
      const stderr = redactText(stderrChunks.join("").slice(0, STDERR_CAP)).trim();
      session.fail(new Error(stderr.length > 0 ? stderr : `stdio 进程退出（${code ?? "unknown"}）`));
    }
  });

  try {
    return await withTimeout(timeoutMs, async () => {
      await session.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "omp-studio", version: "1.0.0" },
      });
      session.notify("notifications/initialized", {});
      return await listToolsFromResult(
        await session.request("tools/list", {}),
      );
    });
  } finally {
    session.close();
    await terminateChild(child);
  }
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  try {
    child.stdin?.end();
  } catch {
    /* already closed */
  }
  child.kill();
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      }),
    ]);
  }
}

async function probeHttp(spec: McpConnectSpec, timeoutMs: number): Promise<string[]> {
  const url = spec.url?.trim();
  if (url === undefined || url.length === 0) {
    throw new Error("远程服务器未配置地址");
  }
  if (looksLikeOAuthOnly(spec)) {
    throw new Error("该服务器需要认证，请在 OMP 中完成 /mcp reauth。");
  }
  const init = await httpRpc(url, spec.headers, 1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "omp-studio", version: "1.0.0" },
  }, timeoutMs);
  if (init.error) throw rpcError(init);
  await httpRpc(url, spec.headers, 2, "notifications/initialized", {}, timeoutMs, true);
  const listed = await httpRpc(url, spec.headers, 3, "tools/list", {}, timeoutMs);
  if (listed.error) throw rpcError(listed);
  return listToolsFromResult(listed.result);
}

function looksLikeOAuthOnly(spec: McpConnectSpec): boolean {
  if (spec.headers === undefined) return false;
  const keys = Object.keys(spec.headers);
  return keys.some((key) => /authorization|oauth/i.test(key) && String(spec.headers?.[key] ?? "").trim().length === 0);
}

async function httpRpc(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  id: number,
  method: string,
  params: unknown,
  timeoutMs: number,
  notification = false,
): Promise<JsonRpcResponse> {
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (notification) return {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  const parsed = parseHttpPayload(text);
  if (parsed === undefined) throw new Error("远程服务器返回无法解析的响应");
  return parsed;
}

function parseHttpPayload(text: string): JsonRpcResponse | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("data:")) {
    for (const line of trimmed.split(/\r?\n/u)) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (payload.length === 0) continue;
      try {
        return JSON.parse(payload) as JsonRpcResponse;
      } catch {
        continue;
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    return undefined;
  }
}

function listToolsFromResult(value: unknown): string[] {
  const record = asRecord(value);
  const tools = record?.tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools.slice(0, MAX_TOOLS)) {
    const name = asRecord(tool)?.name;
    if (typeof name !== "string") continue;
    const safe = sanitizeDisplayText(name, TOOL_NAME_MAX);
    if (safe !== undefined) names.push(safe);
  }
  return names;
}

function rpcError(response: JsonRpcResponse): Error {
  const message = asRecord(response.error)?.message;
  if (typeof message === "string" && message.trim().length > 0) return new Error(message);
  return new Error("MCP JSON-RPC 错误");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

async function withTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("连接超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class NdjsonSession {
  done = false;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #closed = false;

  constructor(private readonly writeLine: (line: string) => void) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const wait = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return wait;
  }

  notify(method: string, params: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.fail(new Error("连接已关闭"));
  }

  #onLine(line: string): void {
    if (this.#closed) return;
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    const id = typeof parsed.id === "number" ? parsed.id : undefined;
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (parsed.error) pending.reject(rpcError(parsed));
    else pending.resolve(parsed.result);
  }
}
