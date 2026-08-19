import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CommandReceipt,
  CommandRequestId,
  McpServerRecord,
  SkillRecord,
  StudioClient,
} from "@omp-studio/client-contract";
import type { StudioSlashCommand } from "./composer/commands";
import { CapabilitiesPage } from "./CapabilitiesPage";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  vi.restoreAllMocks();
});

const T0 = "2026-08-19T00:00:00.000Z";

function skill(name: string, scope: SkillRecord["scope"] = "workspace"): SkillRecord {
  return {
    name,
    desc: `${name} desc`,
    scope,
    sourceKind: "native",
    sourceLabel: "OMP",
    enabled: true,
    hide: false,
  };
}

function mcpServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    name: "filesystem",
    transport: "stdio",
    enabled: true,
    status: "enabled",
    sourceLabel: "用户",
    scope: "user",
    ...overrides,
  };
}

function fakeClient(options?: {
  readonly skills?: SkillRecord[];
  readonly servers?: McpServerRecord[];
  readonly logLines?: readonly string[];
  readonly holdTest?: Promise<void>;
}): StudioClient & {
  readonly query: ReturnType<typeof vi.fn>;
  readonly command: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (name: string, input: { readonly name?: string }) => {
    if (name === "skills.get") {
      return { skills: options?.skills ?? [], plugins: [], warnings: [], generatedAt: T0 };
    }
    if (name === "mcp.get") {
      return { servers: options?.servers ?? [], warnings: [], generatedAt: T0 };
    }
    if (name === "mcp.logs.get") {
      const lines = options?.logLines ?? [];
      return {
        name: input.name ?? "filesystem",
        lines,
        generatedAt: T0,
        ...(lines.length === 0 ? { emptyReason: "尚无日志，请先测试连接" } : {}),
      };
    }
    throw new Error(`unexpected query ${name}`);
  });
  const command = vi.fn(async (commandName: string) => ({
    commandName,
    requestId: `req-${commandName}` as CommandRequestId,
    status: "accepted" as const,
    acceptedAt: T0,
  }));
  const subscribe = vi.fn((filter: { readonly requestId?: string }, cb: (event: { kind: string; receipt: CommandReceipt }) => void) => {
    const requestId = (filter.requestId ?? "req") as CommandRequestId;
    const isTest = String(requestId).includes("mcp.test");
    const fire = () => {
      cb({
        kind: "command.receipt",
        receipt: {
          requestId,
          commandName: "skills.reveal",
          status: "completed",
          result: isTest
            ? { ok: true, latencyMs: 12, detail: "已连接（2 个工具）", toolCount: 2 }
            : { applied: true, runtimeEffect: "new-session", message: "已打开目录" },
          observedAt: T0,
        } as CommandReceipt,
      });
    };
    if (isTest && options?.holdTest) void options.holdTest.then(fire);
    else queueMicrotask(fire);
    return () => undefined;
  });
  return { query, command, bootstrap: vi.fn(), subscribe, close: vi.fn() } as unknown as StudioClient & {
    readonly query: ReturnType<typeof vi.fn>;
    readonly command: ReturnType<typeof vi.fn>;
  };
}

function renderPage(options: {
  preview?: boolean;
  client?: StudioClient;
  onRunSlash?: (command: StudioSlashCommand, args: string) => Promise<boolean>;
} = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === false ? "0" : "1");
  const client = options.client ?? fakeClient();
  render(
    <PreviewModeProvider switchEnabled>
      <CapabilitiesPage
        client={client}
        {...(options.onRunSlash === undefined ? {} : { onRunSlash: options.onRunSlash as never })}
      />
    </PreviewModeProvider>,
  );
  return client;
}

describe("CapabilitiesPage", () => {
  it("opens a skill directory in preview without calling Host", async () => {
    const client = renderPage({ preview: true });
    fireEvent.click(screen.getByRole("button", { name: "打开来源目录：mermaid-verify" }));
    expect(await screen.findByText("演示：已打开目录")).toBeTruthy();
    expect(client.command).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("lists builtin slash commands in real mode and runs ones that need no args", async () => {
    const onRunSlash = vi.fn(async (_command: StudioSlashCommand, _args: string) => true);
    const client = fakeClient({
      skills: [skill("shared")],
      servers: [mcpServer()],
    });
    renderPage({ preview: false, client, onRunSlash });
    await waitFor(() => expect(client.query).toHaveBeenCalledWith("skills.get", {}));
    fireEvent.click(screen.getByRole("tab", { name: /Slash Commands/ }));
    expect(screen.getByText("/compact")).toBeTruthy();
    expect(screen.getByText("/pause")).toBeTruthy();

    const compactRow = document.querySelector('[data-name="/compact"]');
    expect(compactRow).toBeInstanceOf(HTMLElement);
    expect((within(compactRow as HTMLElement).getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled).toBe(true);

    const pauseRow = document.querySelector('[data-name="/pause"]');
    expect(pauseRow).toBeInstanceOf(HTMLElement);
    fireEvent.click(within(pauseRow as HTMLElement).getByRole("button", { name: "执行" }));
    await waitFor(() => expect(onRunSlash).toHaveBeenCalled());
    expect(onRunSlash.mock.calls[0]?.[0]).toMatchObject({ name: "pause" });
    expect(client.command).not.toHaveBeenCalled();
  });

  it("reveals a skill directory and probes MCP in real mode", async () => {
    const client = fakeClient({
      skills: [skill("shared"), skill("oss-audit", "builtin")],
      servers: [mcpServer(), mcpServer({ name: "shadowed", status: "shadowed", enabled: false, scope: "user" })],
    });
    renderPage({ preview: false, client });
    await waitFor(() => expect(screen.getByText("shared")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "打开来源目录：shared" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("skills.reveal", { name: "shared" }));
    expect(await screen.findByText("已打开目录")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^打开来源目录$/ }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("skills.revealRoot", { scope: "user" }));

    fireEvent.click(screen.getByRole("tab", { name: /^MCP/ }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接：filesystem" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("mcp.test", { name: "filesystem", scope: "user" }));
    expect(await screen.findByText("已连接（2 个工具）")).toBeTruthy();

    expect((screen.getByRole("button", { name: "测试连接：shadowed" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "日志：filesystem" }));
    expect(await screen.findByRole("dialog", { name: "filesystem 日志" })).toBeTruthy();
    expect(screen.getByText("尚无日志，请先测试连接")).toBeTruthy();
  });

  it("keeps a bottom toast while an MCP test is in flight", async () => {
    let release!: () => void;
    const holdTest = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = fakeClient({
      servers: [mcpServer()],
      holdTest,
    });
    renderPage({ preview: false, client });
    await waitFor(() => expect(client.query).toHaveBeenCalledWith("mcp.get", {}));
    fireEvent.click(screen.getByRole("tab", { name: /^MCP/ }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接：filesystem" }));
    expect(await screen.findByText("正在测试 filesystem…")).toBeTruthy();
    expect(screen.queryByText("已连接（2 个工具）")).toBeNull();
    release();
    expect(await screen.findByText("已连接（2 个工具）")).toBeTruthy();
    expect(screen.queryByText("正在测试 filesystem…")).toBeNull();
  });

  it("does not send MCP or slash Host commands from preview actions", async () => {
    const onRunSlash = vi.fn(async () => true);
    const client = renderPage({ preview: true, onRunSlash });
    fireEvent.click(screen.getByRole("tab", { name: /^MCP/ }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接：filesystem" }));
    expect(await screen.findByText("演示：已连接（12 个工具）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "日志：filesystem" }));
    expect(await screen.findByRole("dialog", { name: "filesystem 日志" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog", { name: "filesystem 日志" })).getByText("关闭"));
    fireEvent.click(screen.getByRole("tab", { name: /Slash Commands/ }));
    const compactRow = document.querySelector('[data-name="/compact"]');
    fireEvent.click(within(compactRow as HTMLElement).getByRole("button", { name: "执行" }));
    expect(await screen.findByText("演示：已执行 /compact")).toBeTruthy();
    expect(client.command).not.toHaveBeenCalled();
    expect(onRunSlash).not.toHaveBeenCalled();
  });
});
