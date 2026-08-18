import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentDefinitionRecord, StudioClient } from "@omp-studio/client-contract";

import { SubagentsPanel } from "./SubagentsPanel";
import { createPreviewAgentDefinitions } from "./preview/subagentsPreview";

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

afterEach(cleanup);

function stubClient(overrides: Record<string, unknown> = {}): StudioClient {
  return {
    query: vi.fn(),
    command: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as StudioClient;
}

function cardNamed(name: string): HTMLElement {
  const toggle = screen.getByRole("switch", { name: new RegExp(` ${name}$`) });
  const card = toggle.closest("article");
  expect(card).toBeInstanceOf(HTMLElement);
  return card as HTMLElement;
}

function deleteOn(name: string): HTMLElement {
  fireEvent.mouseEnter(cardNamed(name));
  return screen.getByRole("button", { name: `删除 ${name}` });
}

function deleteDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "确认删除" });
}

function confirmDelete(): void {
  fireEvent.click(within(deleteDialog()).getByRole("button", { name: "删除" }));
}

function projectAgent(): AgentDefinitionRecord {
  return {
    name: "local-review",
    description: "Use this agent when reviewing the current workspace only.",
    systemPrompt: "Stay inside the project tree.",
    source: "project",
    sourceLabel: "项目",
    editable: true,
    canDelete: true,
    canFork: false,
    disabled: false,
    contentHash: "hash-local-review",
  };
}

describe("SubagentsPanel card delete", () => {
  it("puts a delete control left of the enable switch on user-created cards only", () => {
    render(<SubagentsPanel client={stubClient()} preview models={null} />);

    const remove = deleteOn("notes");
    const toggle = screen.getByRole("switch", { name: "禁用 notes" });
    expect(remove.nextElementSibling).toBe(toggle);

    fireEvent.mouseEnter(cardNamed("scout"));
    expect(screen.queryByRole("button", { name: "删除 scout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 reviewer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 task" })).toBeNull();
  });

  it("asks for confirmation before removing a user-created card", () => {
    render(<SubagentsPanel client={stubClient()} preview models={null} />);
    expect(document.querySelectorAll("article.sa-card")).toHaveLength(4);

    fireEvent.click(deleteOn("notes"));
    expect(deleteDialog().textContent).toContain("notes");
    expect(deleteDialog().closest(".modal-backdrop")?.parentElement).toBe(document.body);
    expect(document.querySelectorAll("article.sa-card")).toHaveLength(4);

    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll("article.sa-card")).toHaveLength(4);

    fireEvent.click(deleteOn("notes"));
    confirmDelete();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "新建子代理" })).toBeTruthy();
    expect(document.querySelectorAll("article.sa-card")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "打开 scout 详情" })).toBeTruthy();
  });

  it("deletes a project-scoped card through agents.definition.delete after confirm", async () => {
    const full = createPreviewAgentDefinitions();
    const withProject = { ...full, agents: [...full.agents, projectAgent()] };
    let current = withProject;
    const query = vi.fn(async () => current);
    const command = vi.fn(async () => {
      current = {
        ...withProject,
        agents: withProject.agents.filter((agent) => agent.name !== "local-review"),
      };
      return { requestId: "req-del" };
    });
    const client = stubClient({
      query,
      command,
      getState: () => ({
        commands: {
          "req-del": {
            requestId: "req-del",
            commandName: "agents.definition.delete",
            status: "completed",
            result: { applied: true, runtimeEffect: "new-session", message: "已删除子代理定义。" },
            observedAt: "2026-08-18T00:00:00.000Z",
          },
        },
      }),
    });

    render(<SubagentsPanel client={client} preview={false} models={null} />);
    await screen.findByRole("switch", { name: "禁用 local-review" });
    fireEvent.click(deleteOn("local-review"));
    expect(command).not.toHaveBeenCalled();
    confirmDelete();

    await waitFor(() => {
      expect(command).toHaveBeenCalledWith(
        "agents.definition.delete",
        expect.objectContaining({
          name: "local-review",
          scope: "project",
          expectedHash: "hash-local-review",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("button", { name: "删除 local-review" })).toBeNull();
    });
  });
});

describe("SubagentsPanel create editor", () => {
  it("shows a required-field error on the viewport when save is clicked with an empty draft", async () => {
    render(<SubagentsPanel client={stubClient()} preview models={null} />);
    fireEvent.click(screen.getByRole("button", { name: "新建子代理" }));
    const save = await screen.findByRole("button", { name: "保存" });
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain("名称和描述为必填");
    expect(screen.getByRole("status").textContent).toContain("名称和描述为必填");
    expect(screen.getByRole("status").parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
  });

  it("rejects names that the Host cannot store, without calling upsert", async () => {
    const command = vi.fn();
    const query = vi.fn(async () => createPreviewAgentDefinitions());
    render(<SubagentsPanel client={stubClient({ command, query })} preview={false} models={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "新建子代理" }));
    await screen.findByRole("button", { name: "保存" });

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "我的助手" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "Use this agent when taking notes." } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect((await screen.findByRole("alert")).textContent).toContain("名称限");
    expect(command).not.toHaveBeenCalled();
  });

  it("writes a new definition through agents.definition.upsert", async () => {
    let current = createPreviewAgentDefinitions();
    const query = vi.fn(async () => current);
    const command = vi.fn(async () => {
      current = {
        ...current,
        agents: [
          ...current.agents.filter((agent) => agent.name !== "memo"),
          {
            name: "memo",
            description: "Use this agent when writing memos.",
            systemPrompt: "Keep it short.",
            source: "user" as const,
            sourceLabel: "用户",
            editable: true,
            canDelete: true,
            canFork: false,
            disabled: false,
          },
        ],
      };
      return { requestId: "req-up" };
    });
    const client = stubClient({
      query,
      command,
      getState: () => ({
        commands: {
          "req-up": {
            requestId: "req-up",
            commandName: "agents.definition.upsert",
            status: "completed",
            result: { applied: true, runtimeEffect: "new-session", message: "已写入子代理定义。" },
            observedAt: "2026-08-18T00:00:00.000Z",
          },
        },
      }),
    });

    render(<SubagentsPanel client={client} preview={false} models={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "新建子代理" }));
    await screen.findByRole("button", { name: "保存" });

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "memo" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "Use this agent when writing memos." } });
    fireEvent.change(screen.getByPlaceholderText("子代理的系统提示词（frontmatter 以下的 Markdown 正文）"), {
      target: { value: "Keep it short." },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(command).toHaveBeenCalledWith(
        "agents.definition.upsert",
        expect.objectContaining({
          name: "memo",
          description: "Use this agent when writing memos.",
          systemPrompt: "Keep it short.",
          scope: "project",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "新建子代理" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "打开 memo 详情" })).toBeTruthy();
    });
  });

  it("adds a preview draft to the local list on save", async () => {
    render(<SubagentsPanel client={stubClient()} preview models={null} />);
    fireEvent.click(screen.getByRole("button", { name: "新建子代理" }));
    await screen.findByRole("button", { name: "保存" });

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "memo" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "Use this agent when writing memos." } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("已更新本地列表");
      expect(screen.getByRole("button", { name: "打开 memo 详情" })).toBeTruthy();
    });
  });
});

describe("SubagentsPanel editor model picker", () => {
  it("adds a role through the composer model menu", async () => {
    render(<SubagentsPanel client={stubClient()} preview models={null} />);
    fireEvent.click(screen.getByRole("button", { name: "打开 notes 详情" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "添加模型" })).toBeTruthy());

    expect(document.querySelector("[data-tip='@smol']")?.textContent).toContain("Fast");
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));

    const menu = screen.getByRole("menu", { name: "选择模型" });
    expect(within(menu).getByRole("menuitemradio", { name: /Fast/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Default/ }));

    expect(screen.queryByRole("menu", { name: "选择模型" })).toBeNull();
    expect(document.querySelector("[data-tip='@default']")?.textContent).toContain("Default");
  });
});
