import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandInput, CommandName, StudioClient } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import { createPreviewModelConfig } from "./preview/modelConfigFixtures";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { I18nProvider } from "./i18n";

function render(ui: React.ReactElement) {
  const result = rtlRender(<I18nProvider forcedLanguage="zh">{ui}</I18nProvider>);
  return {
    ...result,
    rerender: (nextUi: React.ReactElement) => result.rerender(<I18nProvider forcedLanguage="zh">{nextUi}</I18nProvider>),
  };
}

afterEach(cleanup);

function stubClient(query = vi.fn()) {
  return { query } as unknown as StudioClient;
}

function liveSnapshot(selector = "anthropic/claude-sonnet-4.5"): OperatorStateSnapshot {
  const [provider, id] = selector.split("/") as [string, string];
  return {
    model: { selector, provider, id },
  } as OperatorStateSnapshot;
}

function renderPicker({
  preview = true,
  client = stubClient(),
  can = () => true,
  busy = false,
  onRun = vi.fn(async () => true),
  snapshot,
  refreshKey,
}: {
  preview?: boolean;
  client?: StudioClient;
  can?: (id: string) => boolean;
  busy?: boolean;
  onRun?: (name: CommandName, input: CommandInput<CommandName>) => Promise<boolean>;
  snapshot?: OperatorStateSnapshot;
  refreshKey?: string;
} = {}) {
  const result = render(
    <ComposerModelPicker
      preview={preview}
      client={client}
      can={can}
      busy={busy}
      onRun={onRun}
      {...(snapshot === undefined ? {} : { snapshot })}
      {...(refreshKey === undefined ? {} : { refreshKey })}
    />,
  );
  return {
    ...result,
    rerender: (ui: React.ReactElement) => result.rerender(<I18nProvider forcedLanguage="zh">{ui}</I18nProvider>),
  };
}

describe("ComposerModelPicker", () => {
  it("预览模式：角色列表默认跟随 default 角色，选择角色后更新 pill", async () => {
    const client = stubClient();
    const { container } = renderPicker({ preview: true, client });

    const modelPill = screen.getByRole("button", { name: "选择模型" });
    const thinkPill = screen.getByRole("button", { name: "思考强度" });
    expect(modelPill.firstElementChild?.tagName).toBe("SPAN");
    expect(thinkPill.firstElementChild?.tagName).toBe("SPAN");
    expect(modelPill.lastElementChild?.classList.contains("cmp-pill-caret")).toBe(true);
    expect(thinkPill.lastElementChild?.classList.contains("cmp-pill-caret")).toBe(true);
    fireEvent.click(modelPill);

    // 预览模式不查 Host
    expect(client.query).not.toHaveBeenCalled();

    // 角色列表来自 fixture，default 角色默认选中
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Default/ })).toBeTruthy());
    expect(modelPill.textContent!).toContain("Claude Sonnet 4.5");
    expect(container.querySelector(".cmp-model-label-initial")?.textContent).toBe("C");
    expect(container.querySelector(".cmp-model-label-initial")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Fast/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemradio", { name: /Default/ }).getAttribute("aria-checked")).toBe("true");
    // 未分配可用模型的角色不出现（fixture 中 Designer 模型不可用、Tiny 服务未运行）
    expect(screen.queryByRole("menuitemradio", { name: /Designer/ })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /Tiny/ })).toBeNull();
    expect(screen.getByText("演示")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(modelPill.textContent!).toContain("GPT-5 mini");
    expect(container.querySelector(".cmp-menu")).toBeNull();
  });

  it("预览模式：更多模型悬停展开二级弹窗并可直接选模型", async () => {
    const client = stubClient();
    renderPicker({ preview: true, client });

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Default/ })).toBeTruthy());

    const zone = document.querySelector(".cmp-more-zone") as HTMLElement;
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.mouseEnter(zone);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    expect(screen.getByRole("group", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Claude Opus 4.8/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 4.8/ }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("button", { name: "选择模型" }).textContent!).toContain("Claude Opus 4.8");
  });

  it("预览模式：思考强度按所选模型能力过滤并可切换", async () => {
    const client = stubClient();
    renderPicker({ preview: true, client });

    // 先经二级弹窗选 Claude Opus 4.8（fixture 档位 low/medium/high/max）
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Default/ })).toBeTruthy());
    fireEvent.mouseEnter(document.querySelector(".cmp-more-zone") as HTMLElement);
    await waitFor(() => expect(screen.getByRole("option", { name: /Claude Opus 4.8/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 4.8/ }));

    const thinkPill = screen.getByRole("button", { name: "思考强度" });
    fireEvent.click(thinkPill);
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "High" })).toBeTruthy());
    // 不含该模型不支持的 minimal
    expect(screen.queryByRole("menuitemradio", { name: "Minimal" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(thinkPill.textContent!).toContain("High");
  });

  it("真实模式：pill 跟 snapshot.model，选角色走 session.model.set", async () => {
    const query = vi.fn(async () => createPreviewModelConfig());
    const onRun = vi.fn(async () => true);
    const client = stubClient(query);
    renderPicker({
      preview: false,
      client,
      snapshot: liveSnapshot(),
      onRun,
    });

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    await waitFor(() => expect(query).toHaveBeenCalledWith("models.get", {}));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择模型" }).textContent!).toContain("Claude Sonnet 4.5"));
    expect(screen.getByRole("menuitemradio", { name: /Default/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("演示")).toBeNull();
    expect(screen.queryByText("只改当前会话，不写 models.yml")).toBeNull();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    expect(onRun).toHaveBeenCalledWith("session.model.set", {
      selector: "openai/gpt-5-mini",
      thinking: "low",
    });
    // 不做乐观回填：snapshot 仍是 Sonnet，pill 保持 Runtime 真值
    expect(screen.getByRole("button", { name: "选择模型" }).textContent!).toContain("Claude Sonnet 4.5");
  });

  it("真实模式：思考强度走 session.thinking.set，capability 缺失时禁用", async () => {
    const query = vi.fn(async () => createPreviewModelConfig());
    const onRun = vi.fn(async () => true);
    renderPicker({
      preview: false,
      client: stubClient(query),
      snapshot: {
        model: {
          selector: "anthropic/claude-sonnet-4.5",
          provider: "anthropic",
          id: "claude-sonnet-4.5",
          configuredThinking: "medium",
        },
      } as OperatorStateSnapshot,
      can: (id) => id === "session.model.set" || id === "session.thinking.set",
      onRun,
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "选择模型" }).textContent!).toContain("Claude Sonnet 4.5"));
    fireEvent.click(screen.getByRole("button", { name: "思考强度" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "High" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    expect(onRun).toHaveBeenCalledWith("session.thinking.set", { level: "high" });
  });

  it("真实模式：流式期间仍可切换模型，走 session.model.set", async () => {
    const query = vi.fn(async () => createPreviewModelConfig());
    const onRun = vi.fn(async () => true);
    renderPicker({
      preview: false,
      client: stubClient(query),
      snapshot: { ...liveSnapshot(), isStreaming: true },
      onRun,
    });

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Fast/ })).toBeTruthy());
    expect((screen.getByRole("menuitemradio", { name: /Fast/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("当前轮次仍用原模型，下一轮对话才生效")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    expect(onRun).toHaveBeenCalledWith("session.model.set", {
      selector: "openai/gpt-5-mini",
      thinking: "low",
    });
  });

  it("真实模式：Runtime 未暴露 session.model.set 时角色不可选", async () => {
    const query = vi.fn(async () => createPreviewModelConfig());
    const onRun = vi.fn(async () => true);
    renderPicker({
      preview: false,
      client: stubClient(query),
      snapshot: liveSnapshot(),
      can: () => false,
      onRun,
    });

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Fast/ })).toBeTruthy());
    expect((screen.getByRole("menuitemradio", { name: /Fast/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText("Runtime 未暴露 session.model.set")).toBeTruthy();
  });

  it("挂载与切预览/切对话时自动刷新，无需点开菜单", async () => {
    const query = vi.fn(async () => createPreviewModelConfig());
    const client = stubClient(query);
    const { rerender } = render(
      <ComposerModelPicker
        preview={false}
        client={client}
        can={() => true}
        busy={false}
        onRun={vi.fn(async () => true)}
        snapshot={liveSnapshot()}
        refreshKey="s1·t1"
      />,
    );

    // 挂载即取数，pill 不等点击就更新
    await waitFor(() => expect(screen.getByRole("button", { name: "选择模型" }).textContent!).toContain("Claude Sonnet 4.5"));

    // 切对话：refreshKey 变化触发重取
    query.mockClear();
    rerender(
      <ComposerModelPicker
        preview={false}
        client={client}
        can={() => true}
        busy={false}
        onRun={vi.fn(async () => true)}
        snapshot={liveSnapshot()}
        refreshKey="s1·t2"
      />,
    );
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));

    // 切预览：数据源切到 fixture，不再发 Host 查询
    rerender(
      <ComposerModelPicker
        preview={true}
        client={client}
        can={() => true}
        busy={false}
        onRun={vi.fn(async () => true)}
        refreshKey="s1·t2"
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "选择模型" }).textContent!).toContain("Claude Sonnet 4.5"));
    expect(query).toHaveBeenCalledTimes(1);
  });
});
