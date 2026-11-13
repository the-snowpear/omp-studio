import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InteractionId, SessionId } from "@omp-studio/client-contract";
import type { InteractionForm } from "@omp-studio/studio-protocol";
import { InteractionDeck } from "../InteractionDeck";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_FORM_LONG, PREVIEW_FORM_SHORT } from "../preview/formPreview";
import { closeFormSession, FormSession, type FormInteraction, type ReadInteractionForm } from "./FormSession";
import { QueuedDeck, type QueuedDeckItem } from "./QueuedDeck";

const interactions: FormInteraction[] = [];
const localSessions: FormSession[] = [];
let originalTier: string | null;
let originalUrl: string;
let counter = 0;
beforeEach(() => {
  originalTier = document.documentElement.getAttribute("data-perf-tier");
  originalUrl = window.location.href;
  document.documentElement.setAttribute("data-perf-tier", "L1");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:form-graphic");
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  cleanup();
  for (const interaction of interactions.splice(0)) closeFormSession(interaction);
  for (const session of localSessions.splice(0)) session.close();
  if (originalTier === null) document.documentElement.removeAttribute("data-perf-tier");
  else document.documentElement.setAttribute("data-perf-tier", originalTier);
  window.history.replaceState(null, "", originalUrl);
  vi.unstubAllGlobals();
});
function pending(dto: InteractionForm, id = `form-ui-${++counter}`): FormInteraction {
  const interaction: FormInteraction = { kind: "form", interactionId: id as InteractionId, sessionId: id as SessionId, leaseGeneration: 1, title: "Agent 提问", summary: "确认交互行为", fieldCount: dto.fields.length, sectionCount: dto.sections.length };
  interactions.push(interaction);
  return interaction;
}
async function local(dto: InteractionForm, id: string): Promise<FormSession> {
  const session = new FormSession(pending(dto, id));
  localSessions.push(session);
  await session.load(() => Promise.resolve(dto));
  return session;
}

it("preserves field DOM and edits through fieldset navigation, collapse, expansion and metadata refresh", async () => {
  const interaction = pending(PREVIEW_FORM_LONG);
  const read = vi.fn<ReadInteractionForm>(() => Promise.resolve(PREVIEW_FORM_LONG));
  const respond = vi.fn(() => Promise.resolve(true));
  const { rerender } = render(<InteractionDeck interaction={interaction} readForm={read} onRespond={respond} disabled={false} />);
  await screen.findByRole("navigation", { name: "表单题组" });
  fireEvent.click(screen.getByRole("button", { name: /交互参数/ }));
  const input = screen.getByRole("textbox", { name: "惯性衰减系数" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "0.85" } });
  fireEvent.click(screen.getByRole("button", { name: /1\s*惯性/ }));
  expect(input.isConnected).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /交互参数/ }));
  expect(screen.getByRole("textbox", { name: "惯性衰减系数" })).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: "收起表单" }));
  expect(input.isConnected).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "展开 / Show" }));
  fireEvent.click(screen.getByRole("button", { name: /交互参数/ }));
  fireEvent.click(screen.getByRole("button", { name: "放大表单" }));
  rerender(<InteractionDeck interaction={{ ...interaction, summary: "更新的摘要" }} readForm={read} onRespond={respond} disabled={false} />);
  expect(screen.getByRole("textbox", { name: "惯性衰减系数" })).toBe(input);
  expect(input.value).toBe("0.85");
  expect(read).toHaveBeenCalledTimes(1);
});

it("keeps transient drafts after a Deck host remount but starts fresh on a new lease", async () => {
  const interaction = pending(PREVIEW_FORM_LONG);
  const read = vi.fn<ReadInteractionForm>(() => Promise.resolve(PREVIEW_FORM_LONG));
  const respond = vi.fn(() => Promise.resolve(true));
  const first = render(<InteractionDeck interaction={interaction} readForm={read} onRespond={respond} disabled={false} />);
  await screen.findByRole("navigation", { name: "表单题组" });
  fireEvent.click(screen.getByRole("button", { name: /交互参数/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "惯性衰减系数" }), { target: { value: "0.81" } });
  first.unmount();
  const second = render(<InteractionDeck interaction={interaction} readForm={read} onRespond={respond} disabled={false} />);
  expect((screen.getByRole("textbox", { name: "惯性衰减系数" }) as HTMLInputElement).value).toBe("0.81");
  expect(read).toHaveBeenCalledTimes(1);
  const next = { ...interaction, leaseGeneration: 2 };
  interactions.push(next);
  second.rerender(<InteractionDeck interaction={next} readForm={read} onRespond={respond} disabled={false} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await screen.findByRole("navigation", { name: "表单题组" });
  fireEvent.click(screen.getByRole("button", { name: /交互参数/ }));
  expect((screen.getByRole("textbox", { name: "惯性衰减系数" }) as HTMLInputElement).value).toBe("0.92");
});

it("does not remount a visited form's input while paging to another queued form", async () => {
  const a = await local(PREVIEW_FORM_LONG, `queue-a-${++counter}`);
  const b = await local(PREVIEW_FORM_SHORT, `queue-b-${++counter}`);
  const items: QueuedDeckItem[] = [
    { kind: "form", id: "a", title: "参数", summary: "参数", session: a },
    { kind: "form", id: "b", title: "惯性", summary: "惯性", session: b },
  ];
  render(<QueuedDeck items={items} regionLabel="待处理提问" />);
  fireEvent.click(screen.getByRole("button", { name: /交互参数/ }));
  const input = screen.getByRole("textbox", { name: "惯性衰减系数" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "0.7" } });
  fireEvent.click(screen.getByRole("button", { name: "下一个请求" }));
  expect(input.isConnected).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "上一个请求" }));
  expect(screen.getByRole("textbox", { name: "惯性衰减系数" })).toBe(input);
  expect(input.value).toBe("0.7");
});

it("makes Other reachable from radio keys, keeps option notes attached and sends native named data", async () => {
  const interaction = pending(PREVIEW_FORM_SHORT);
  const respond = vi.fn(() => Promise.resolve(true));
  render(<InteractionDeck interaction={interaction} readForm={() => Promise.resolve(PREVIEW_FORM_SHORT)} onRespond={respond} disabled={false} />);
  const setting = await screen.findByRole("radio", { name: /^做成设置项/ });
  fireEvent.keyDown(setting, { key: "End" });
  const other = await screen.findByRole("textbox", { name: "Other：拖拽平移是否需要惯性？" });
  await waitFor(() => expect(document.activeElement).toBe(other));
  fireEvent.change(other, { target: { value: "只给触控板加惯性" } });
  expect(setting.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("radio", { name: "默认关" }));
  fireEvent.click(screen.getByRole("button", { name: "添加附注：默认关" }));
  fireEvent.change(screen.getByRole("textbox", { name: "附注：默认关" }), { target: { value: "保留精确定位" } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith("submit", { data: { inertia: "只给触控板加惯性", default: "off" }, notes: [
    { name: "default", question: "如果做成设置项，默认值怎么定？", option: "默认关", value: "off", text: "保留精确定位" },
  ] }));
});

it("never inserts model HTML or SVG into the privileged form DOM", async () => {
  const dto: InteractionForm = { ...PREVIEW_FORM_SHORT, sections: [
    { title: [], fieldset: false, blocks: [
      { kind: "text", heading: false, spans: [{ text: '<img src="https://untrusted.invalid/pixel" onerror="run()">' }] },
      { kind: "graphic", format: "svg", alt: "model diagram", source: '<svg xmlns="http://www.w3.org/2000/svg" aria-label="model diagram"><script>parent.ompStudio.command()</script></svg>' },
    ] },
    ...PREVIEW_FORM_SHORT.sections.slice(1),
  ] };
  const { container } = render(<InteractionDeck interaction={pending(dto)} readForm={() => Promise.resolve(dto)} onRespond={() => Promise.resolve(true)} disabled={false} />);
  await screen.findByText(/Executable SVG elements are disabled/);
  expect(container.querySelector('svg[aria-label="model diagram"]')).toBeNull();
  expect(container.querySelector('img[src="https://untrusted.invalid/pixel"]')).toBeNull();
  expect(screen.getByText(/<img src=/).textContent).toContain('onerror="run()"');
});

it("hides preview marks in both compact and open forms and keeps demo submissions local", async () => {
  window.history.replaceState(null, "", "?preview=1&marks=off");
  const session = await local(PREVIEW_FORM_SHORT, `preview-form-${++counter}`);
  render(<PreviewModeProvider switchEnabled><QueuedDeck demo items={[{ kind: "form", id: "preview", title: "Agent 提问", summary: "交互默认", session }]} regionLabel="待处理提问" /></PreviewModeProvider>);
  expect(screen.queryByText("演示")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "收起表单" }));
  expect(screen.queryByText("演示")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开 / Show" }));
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(session.getMeta().phase).toBe("closed"));
  expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
});
