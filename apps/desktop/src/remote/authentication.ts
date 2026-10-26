import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensurePrivateSocketDirectory, privateSocketPath } from "@omp-studio/studio-host";
import { sshArguments, systemSshExecutable, type SshConnection } from "./platform.js";
import { RemoteConnectionError, connectionCancelled, sshFailure } from "./errors.js";

export interface SshAuthenticationRequest {
  readonly env: NodeJS.ProcessEnv;
  dispose(): void;
}

export interface SshAuthentication {
  request(): SshAuthenticationRequest;
  close(): Promise<void>;
}

interface Ticket { readonly expires: number; readonly timer: NodeJS.Timeout; }
const MAX_PASSWORD_BYTES = 4096;
const REQUEST_TTL_MS = 90_000;

/** Passwords stay in Main; each SSH child receives only a one-use askpass ticket. */
export async function createPasswordAuthentication(connection: SshConnection, password: string, helperDirectory: string, signal: AbortSignal): Promise<SshAuthentication> {
  if (typeof password !== "string" || password.length === 0 || /[\r\n\0]/u.test(password)) throw new RemoteConnectionError("authentication", "请输入有效的 SSH 密码（不支持换行或 NUL）");
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new RemoteConnectionError("authentication", "SSH 密码不能超过 4096 个 UTF-8 字节");
  const secret = Buffer.from(password, "utf8");
  password = "";
  let directory: string | undefined;
  let server: Server | undefined;
  try {
    signal.throwIfAborted();
    const helper = join(helperDirectory, process.platform === "win32" ? "omp-ssh-askpass.exe" : "askpass.sh");
    await access(helper);
    const { stdout } = await promisify(execFile)(systemSshExecutable(), ["-G", ...sshArguments(connection)], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
    const config = new Map(stdout.split(/\r?\n/u).map(line => { const at = line.indexOf(" "); return [line.slice(0, at), line.slice(at + 1)] as const; }));
    const user = config.get("user");
    const hostname = config.get("hostname");
    const hasProxy = [config.get("proxyjump"), config.get("proxycommand")].some(value => value !== undefined && value !== "none");
    if (hasProxy) throw new RemoteConnectionError("configuration", "账密模式暂不支持跳板机；请使用系统密钥或 agent 模式");
    if (!user || !hostname) throw new RemoteConnectionError("configuration", "系统 SSH 未能解析目标用户名和主机");
    const prompt = `${user}@${hostname}'s password:`;
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\omp-ssh-askpass-${randomUUID()}`
      : privateSocketPath(directory = await ensurePrivateSocketDirectory(`ssh-askpass:${randomUUID()}`), "auth.sock");
    const tickets = new Map<string, Ticket>();
    const sockets = new Set<Socket>();
    let closed = false;
    const forget = (token: string): void => { const ticket = tickets.get(token); if (ticket) clearTimeout(ticket.timer); tickets.delete(token); };
    server = createServer(socket => {
      if (closed || sockets.size >= 16) { socket.destroy(); return; }
      sockets.add(socket);
      socket.setTimeout(5_000, () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      let input = "";
      let answered = false;
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        if (answered) return;
        input += chunk;
        if (input.length > 8192) { socket.destroy(); return; }
        const lines = input.split("\n");
        if (lines.length < 3) return;
        answered = true;
        const token = lines[0]!;
        const ticket = tickets.get(token);
        forget(token);
        const suppliedPrompt = Buffer.from(lines[1]!, "base64").toString("utf8").trim();
        const supplied = Buffer.from(suppliedPrompt);
        const expected = Buffer.from(prompt);
        if (closed || !ticket || ticket.expires < Date.now() || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.end(Buffer.from([0])); return; }
        socket.write(Buffer.from([1]));
        socket.end(secret);
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(endpoint, () => { server!.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    const listener = server;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      secret.fill(0);
      for (const token of tickets.keys()) forget(token);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => listener.close(() => resolve()));
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    };
    try { signal.throwIfAborted(); } catch (error) { await close(); throw error; }
    listener.on("error", () => { void close(); });
    return {
      request() {
        if (closed) throw new RemoteConnectionError("authentication", "SSH 密码已清除，请重新连接并输入密码");
        if (tickets.size >= 16) throw new Error("Too many SSH authentication requests");
        const token = randomBytes(32).toString("base64url");
        const timer = setTimeout(() => forget(token), REQUEST_TTL_MS);
        timer.unref();
        tickets.set(token, { expires: Date.now() + REQUEST_TTL_MS, timer });
        return {
          env: {
            ...process.env,
            SSH_ASKPASS: helper,
            SSH_ASKPASS_REQUIRE: "force",
            DISPLAY: process.env.DISPLAY || "omp-studio:0",
            OMP_SSH_ASKPASS_ENDPOINT: endpoint,
            OMP_SSH_ASKPASS_TICKET: token,
            OMP_SSH_ASKPASS_NODE: process.execPath,
            OMP_SSH_ASKPASS_SCRIPT: join(helperDirectory, "askpass.cjs"),
          },
          dispose: () => forget(token),
        };
      },
      close,
    };
  } catch (error) {
    secret.fill(0);
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) throw connectionCancelled();
    if (error instanceof RemoteConnectionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RemoteConnectionError("configuration", "SSH 账密认证组件未安装，请重新构建或更新桌面客户端");
    const failure = sshFailure(typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "", error);
    if (failure.connectionCode !== "unknown") throw failure;
    throw new RemoteConnectionError("configuration", "无法准备 SSH 账密认证，请检查系统 SSH 配置及认证组件");
  }
}

export function sshAuthenticationRequest(connection: SshConnection, authentication?: SshAuthentication): SshAuthenticationRequest | undefined {
  if (connection.authMode !== "password") return undefined;
  if (!authentication) throw new RemoteConnectionError("authentication", "此连接需要密码，请重新连接并在应用内输入");
  return authentication.request();
}
