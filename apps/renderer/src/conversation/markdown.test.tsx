import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePathKind } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewSurface } from "../preview/PreviewContext";
import { registerFileOpener } from "../files/fileLinks";
import { registerFileBrowser } from "../fileBrowser/fileBrowserLinks";
import { invalidateFilePathKinds, registerPathResolver } from "../files/pathResolution";

import { SpillViewer } from "./SpillLink";
import { MarkdownInline, MarkdownText } from "./markdown";

vi.mock("../conversationWorkspace/Context", () => ({ useConversationView: () => ({ document: { id: "markdown-tests", ref: { targetId: "markdown-host", workspaceId: "markdown-workspace" } } }) }));
const owner = "markdown-tests", stops: (() => void)[] = [];
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (name: string) => act(async () => fireEvent.click(screen.getByRole("link", { name })));
const markdown = (text: string, language: "zh" | "en" = "zh", preview = false) => <PreviewSurface preview={preview}><I18nProvider forcedLanguage={language}><MarkdownText text={text} /></I18nProvider></PreviewSurface>;
afterEach(() => { cleanup(); for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("MarkdownInline", () => {
  it("drops javascript and other unsafe hrefs that Ask cards would otherwise render", () => {
    const { container } = render(
      <MarkdownInline text={'click [here](javascript:alert(1)) and [docs](https://example.com/a)'} />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("opens current and legacy spill URIs written as inline code", () => {
    const open = vi.fn();
    render(<SpillViewer.Provider value={open}><MarkdownInline text={"`local://7.log` and `artifact://8`"} /></SpillViewer.Provider>);
    for (const uri of ["local://7.log", "artifact://8"]) {
      fireEvent.click(screen.getByRole("button", { name: uri }));
      expect(open).toHaveBeenLastCalledWith(uri);
    }
  });

  it("renders http images only", () => {
    const { container } = render(
      <MarkdownInline text={'![ok](https://example.com/a.png) ![bad](file:///C:/secret.png)'} />,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
  });
});

describe("AI Markdown file references", () => {
  it("waits for the Host and links actual bare files and directories while keeping API text plain", async () => {
    vi.useFakeTimers();
    const paths = ["App.vue", "Main.kt", "Cargo.lock", "tsconfig.jsonc", ".env.local"];
    const resolve = vi.fn(async (batch: readonly string[]) => batch.map(path => ({ path, kind: path === "src" ? "directory" as const : paths.includes(path) ? "file" as const : "missing" as const })));
    stops.push(registerPathResolver(owner, resolve));
    const view = render(markdown([...paths, "src", "client.query", "RSA/ECB/PKCS1Padding", "not-a-file.json"].map(path => `\`${path}\``).join(" · ")));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    await advance(40);
    expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual([...paths, "src"]);
    expect(view.container.textContent).toContain("RSA/ECB/PKCS1Padding");
  });

  it("does not turn candidates into file links when both Host probes fail", async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => { throw new Error("Host unavailable"); }), open = vi.fn();
    stops.push(registerPathResolver(owner, resolve), registerFileOpener(owner, open));
    render(markdown("`not-a-file.json` and [文档](not-a-file.md)"));
    await advance(1200);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByText("not-a-file.json"));
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open a file that disappeared after its automatic classification", async () => {
    vi.useFakeTimers();
    let kind: WorkspacePathKind = "file";
    const open = vi.fn(), resolve = vi.fn(async (paths: readonly string[]) => paths.map(path => ({ path, kind })));
    stops.push(registerPathResolver(owner, resolve), registerFileOpener(owner, open));
    render(markdown("[报告](report.txt)"));
    await advance(40);
    kind = "missing";
    await click("报告");
    expect(resolve).toHaveBeenLastCalledWith(["report.txt"], { workspaceId: "markdown-workspace", targetId: "markdown-host" }, true);
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "报告" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("路径不存在");
  });

  it("routes a former file to the folder browser when its current type changed", async () => {
    vi.useFakeTimers();
    let kind: WorkspacePathKind = "file";
    const open = vi.fn(), folder = vi.fn();
    stops.push(registerPathResolver(owner, async paths => paths.map(path => ({ path, kind }))), registerFileOpener(owner, open), registerFileBrowser(owner, folder));
    render(markdown("`docs/report.txt`"));
    await advance(40);
    kind = "directory";
    await click("docs/report.txt");
    expect(open).not.toHaveBeenCalled();
    expect(folder).toHaveBeenCalledWith({ path: "docs/report.txt", workspaceId: "markdown-workspace", targetId: "markdown-host" });
  });

  it("refreshes mounted missing paths on file changes and on a later hover", async () => {
    vi.useFakeTimers();
    const existing = new Set<string>();
    stops.push(registerPathResolver(owner, async paths => paths.map(path => ({ path, kind: existing.has(path) ? "file" as const : "missing" as const }))));
    render(markdown("`generated/report.txt` and `external.txt`"));
    await advance(1200);
    expect(screen.queryByRole("link")).toBeNull();
    existing.add("generated/report.txt");
    act(() => invalidateFilePathKinds("markdown-host", "markdown-workspace"));
    await advance(40);
    expect(screen.getByRole("link", { name: "generated/report.txt" })).toBeTruthy();
    existing.add("external.txt");
    fireEvent.mouseEnter(screen.getByText("external.txt").closest(".file-path-reference")!);
    await advance(40);
    expect(screen.getByRole("link", { name: "external.txt" })).toBeTruthy();
  });

  it("keeps a deferred directory available for an explicit click without following it automatically", async () => {
    vi.useFakeTimers();
    const folder = vi.fn(), resolve = vi.fn(async (paths: readonly string[], _target: unknown, explicit?: boolean) => explicit ? paths.map(path => ({ path, kind: "directory" as const })) : []);
    stops.push(registerPathResolver(owner, resolve), registerFileBrowser(owner, folder));
    render(markdown("`linked/docs`"));
    await advance(1200);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link").getAttribute("data-tip")).toBe("点击确认并打开此路径");
    await click("linked/docs");
    expect(resolve).toHaveBeenLastCalledWith(["linked/docs"], { workspaceId: "markdown-workspace", targetId: "markdown-host" }, true);
    expect(folder).toHaveBeenCalledWith({ path: "linked/docs", workspaceId: "markdown-workspace", targetId: "markdown-host" });
  });

  it("keeps commands inside language-less, indented and streaming code blocks as code", async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => []);
    stops.push(registerPathResolver(owner, resolve));
    const view = render(markdown("```\ncat docs/README.md\n```\n\n    cat docs/README.md\n\n```bash\ncat docs/README.md\n```"));
    expect(view.container.querySelectorAll("pre")).toHaveLength(3);
    expect(view.container.querySelector("pre .file-reference")).toBeNull();
    await advance(1200);
    expect(resolve).not.toHaveBeenCalled();
    view.rerender(<MarkdownText text="```\ncat docs/README.md" streaming />);
    expect(view.container.querySelector("pre .file-reference")).toBeNull();
    view.rerender(markdown("```\ncat docs/README.md\n```"));
    expect(view.container.querySelector("pre .file-reference")).toBeNull();
  });

  it("opens Windows backslash links after Markdown encoding, including their line and column", async () => {
    vi.useFakeTimers();
    const path = ["D:", "项目", "src", "main.ts"].join(String.fromCharCode(92)), open = vi.fn();
    stops.push(registerPathResolver(owner, async paths => paths.map(path => ({ path, kind: "file" as const }))), registerFileOpener(owner, open));
    render(markdown(`[Windows 文件](${path}:42:8)`));
    await advance(40);
    await click("Windows 文件");
    expect(open).toHaveBeenCalledWith({ path, line: 42, column: 8, workspaceId: "", targetId: "markdown-host", source: "system" });
  });

  it("separates a document fragment and query from its actual filename", async () => {
    vi.useFakeTimers();
    const open = vi.fn(), resolve = vi.fn(async (paths: readonly string[]) => paths.map(path => ({ path, kind: "file" as const })));
    stops.push(registerPathResolver(owner, resolve), registerFileOpener(owner, open));
    render(markdown("[安装说明](README.md?plain=1#installation) and [带井号文件](docs/notes%23draft.md#安装)"));
    await advance(40);
    expect(resolve.mock.calls[0]?.[0]).toEqual(["README.md", "docs/notes#draft.md"]);
    await click("安装说明");
    expect(open).toHaveBeenCalledWith({ path: "README.md", fragment: "installation", workspaceId: "markdown-workspace", targetId: "markdown-host" });
    await click("带井号文件");
    expect(open).toHaveBeenCalledWith({ path: "docs/notes#draft.md", fragment: "安装", workspaceId: "markdown-workspace", targetId: "markdown-host" });
  });

  it("preserves percent sequences in raw inline filenames and unwraps a quoted path", async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    stops.push(registerPathResolver(owner, async paths => paths.map(path => ({ path, kind: "file" as const }))), registerFileOpener(owner, open));
    render(markdown('`src/report%20draft.md` and `"D:/Program Files/demo/main.ts"`'));
    await advance(80);
    await click("src/report%20draft.md");
    expect(open).toHaveBeenCalledWith({ path: "src/report%20draft.md", workspaceId: "markdown-workspace", targetId: "markdown-host" });
    await click('"D:/Program Files/demo/main.ts"');
    expect(open).toHaveBeenCalledWith({ path: "D:/Program Files/demo/main.ts", workspaceId: "", targetId: "markdown-host", source: "system" });
  });

  it("routes protocol-relative web links through the browser rather than the filesystem", async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => []);
    stops.push(registerPathResolver(owner, resolve));
    const view = render(markdown("[网页报告](//example.com/reports/report.pdf)"));
    const link = screen.getByRole("link", { name: "网页报告" });
    expect(link.getAttribute("href")).toMatch(/^https?:\/\/example\.com\/reports\/report\.pdf$/);
    expect(view.container.querySelector(".file-reference")).toBeNull();
    await advance(1200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("loads an absolute AI image from the system file service on the chat's Host", async () => {
    const open = vi.fn(async () => ({ id: "absolute-image", url: "omp-file://viewer/absolute-image" })), release = vi.fn(async () => {});
    vi.stubGlobal("ompStudioChrome", { files: { open, release } });
    const view = render(markdown("![生成图](file:///C:/outputs/chart.png)"));
    await waitFor(() => expect(screen.getByAltText("生成图")).toBeTruthy());
    expect(open).toHaveBeenCalledWith({ path: "C:/outputs/chart.png", workspaceId: "", targetId: "markdown-host", source: "system" });
    view.unmount();
    expect(release).toHaveBeenCalledWith("absolute-image");
  });

  it("uses fixtures for preview file and directory links and keeps ordinary code plain", async () => {
    const resolve = vi.fn(async () => []), open = vi.fn(), folder = vi.fn();
    stops.push(registerPathResolver(owner, resolve), registerFileOpener(owner, open), registerFileBrowser(owner, folder));
    render(markdown("`docs/README.md` · `docs` · `client.query` · `not-a-file.json` · [missing folder](unknown/)", "en", true));
    await click("docs/README.md"); await click("docs");
    expect(open).toHaveBeenCalledWith({ path: "docs/README.md", workspaceId: "markdown-workspace", targetId: "markdown-host" });
    expect(folder).toHaveBeenCalledWith({ path: "docs", workspaceId: "markdown-workspace", targetId: "markdown-host" });
    expect(screen.queryByRole("link", { name: "client.query" })).toBeNull();
    expect(screen.queryByRole("link", { name: "not-a-file.json" })).toBeNull();
    expect(screen.queryByRole("link", { name: "missing folder" })).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("updates an existing path error through zh → en → zh without changing the path or retrying", async () => {
    vi.useFakeTimers();
    let kind: WorkspacePathKind = "file";
    const resolve = vi.fn(async (paths: readonly string[]) => paths.map(path => ({ path, kind })));
    stops.push(registerPathResolver(owner, resolve));
    const text = "[报告](report.txt)", view = render(markdown(text));
    await advance(40); kind = "missing"; await click("报告");
    expect(screen.getByRole("status").textContent).toBe("路径不存在");
    const reads = resolve.mock.calls.length;
    view.rerender(markdown(text, "en"));
    expect(screen.getByRole("status").textContent).toBe("Path does not exist");
    view.rerender(markdown(text, "zh"));
    expect(screen.getByRole("status").textContent).toBe("路径不存在");
    expect(resolve).toHaveBeenCalledTimes(reads);
    expect(screen.getByText("报告")).toBeTruthy();
  });
});
