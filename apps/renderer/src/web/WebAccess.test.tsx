import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import {
  __resetAppSettingsForTests,
  getAppSettings,
  updateAppSettings,
} from "../settings/appSettings";
import { WebAccess } from "./WebAccess";
import { WebAccessProvider } from "./WebAccessContext";
import { WebAccessSettings } from "./WebAccessSettings";
import { updateControlState, useHostControl } from "./controlState";
import type { WebAccessApi } from "../../../desktop/src/web/shared";

function ControlProbe() {
  return <output aria-label="Writable">{String(useHostControl())}</output>;
}

function renderAccess() {
  return render(<PreviewModeProvider switchEnabled><I18nProvider><WebAccessProvider>
    <WebAccessSettings /><WebAccess /><ControlProbe />
  </WebAccessProvider></I18nProvider></PreviewModeProvider>);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  __resetAppSettingsForTests(null);
  updateControlState(
    { version: "test", owner: { id: "test", name: "Test" } },
    "test",
  );
});

function prepareDrag() {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  });
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains("web-control-bar")) return new DOMRect(672, 728, 320, 40);
    if (this.classList.contains("web-access-strip")) return this.classList.contains("is-floating")
      ? new DOMRect(Number(this.style.left.replace("px", "")), Number(this.style.top.replace("px", "")), 320, 40)
      : new DOMRect(0, 728, 1024, 40);
    return new DOMRect();
  });
  return (x: number, y: number, finish = true) => {
    const handle = screen.getByRole("button", { name: /移动 Web 控制条|Move Web control bar/ });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 680, clientY: 740 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y });
    if (finish) fireEvent.pointerUp(window, { pointerId: 1, clientX: x, clientY: y });
  };
}

it("remembers a dragged control bar, cancels a later move and keeps it reachable in a smaller window", async () => {
  const dragTo = prepareDrag();
  __resetAppSettingsForTests(JSON.stringify({ language: "zh", webAccessVisible: true }));
  const takeControl = vi.fn(async () => ({ version: "2" }));
  vi.stubGlobal("ompStudioWebAccess", {
    status: async () => ({ deviceId: "desktop", addresses: [], devices: [], control: { version: "1" } }),
    takeControl,
    onControl: () => () => {},
  });
  const first = renderAccess();
  dragTo(300, 220);
  const bar = screen.getByRole("complementary", { name: "主机控制" });
  expect(bar.classList.contains("is-floating")).toBe(true);
  expect(getAppSettings().webAccessPosition).toEqual({ x: 284, y: 208 });
  expect(takeControl).not.toHaveBeenCalled();
  const stored = localStorage.getItem("omp.appSettings");
  first.unmount();
  __resetAppSettingsForTests(stored);
  renderAccess();
  expect(screen.getByRole("complementary", { name: "主机控制" }).style.left).toBe("284px");
  dragTo(420, 300, false);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(localStorage.getItem("omp.appSettings")).toBe(stored);
  expect(screen.getByRole("complementary", { name: "主机控制" }).style.left).toBe("284px");
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 240);
  fireEvent.resize(window);
  const resized = screen.getByRole("complementary", { name: "主机控制" });
  expect(resized.style.left).toBe("62px");
  expect(resized.style.top).toBe("192px");
  act(() => updateAppSettings({ language: "en" }));
  expect(screen.getByRole("button", { name: "Dock control bar at bottom" })).toBeTruthy();
  act(() => updateAppSettings({ language: "zh" }));
  fireEvent.click(screen.getByRole("button", { name: "控制条回到底部" }));
  expect(getAppSettings().webAccessPosition).toBeNull();
  expect(screen.getByRole("complementary", { name: "主机控制" }).classList.contains("is-floating")).toBe(false);
});

it("keeps preview dragging and keyboard positioning local, with a way to dock from settings", () => {
  const dragTo = prepareDrag();
  window.history.replaceState(null, "", "/?preview=1");
  __resetAppSettingsForTests(JSON.stringify({ language: "en" }));
  vi.stubGlobal("ompStudioWebAccess", undefined);
  renderAccess();
  fireEvent.click(screen.getByRole("switch", { name: "Show Web control bar" }));
  const stored = localStorage.getItem("omp.appSettings");
  dragTo(300, 220);
  expect(screen.getByRole("complementary", { name: "Host control" }).style.left).toBe("284px");
  const handle = screen.getByRole("button", { name: "Move Web control bar" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(screen.getByRole("complementary", { name: "Host control" }).style.left).toBe("294px");
  expect(localStorage.getItem("omp.appSettings")).toBe(stored);
  expect(getAppSettings().webAccessPosition).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dock at bottom" }));
  expect(screen.getByRole("complementary", { name: "Host control" }).classList.contains("is-floating")).toBe(false);
  expect(localStorage.getItem("omp.appSettings")).toBe(stored);
});

it("keeps device edits and the open panel while the mounted language changes", async () => {
  __resetAppSettingsForTests(JSON.stringify({ language: "zh" }));
  const rename = vi.fn(async () => {});
  const api: WebAccessApi = {
    status: async () => ({
      deviceId: "desktop",
      origin: "http://127.0.0.1:8560",
      addresses: [],
      devices: [{ id: "phone", name: "My phone", createdAt: 1, lastSeenAt: 1 }],
      control: { version: "1", owner: { id: "desktop", name: "Desktop" } },
    }),
    takeControl: async () => ({ version: "2" }),
    pair: async () => ({ url: "", qr: "", expiresAt: 0 }),
    revoke: async () => {},
    rename,
    listen: async () => api.status(),
    exportCertificate: async () => true,
    onControl: () => () => {},
  };
  vi.stubGlobal("ompStudioWebAccess", api);
  renderAccess();
  expect(screen.queryByRole("complementary", { name: "主机控制" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "管理 Web 访问" }));
  const input = await screen.findByRole("textbox", { name: "设备名称" });
  fireEvent.change(input, { target: { value: "Renamed phone" } });
  act(() => updateAppSettings({ language: "en" }));
  expect(
    screen.getByRole("dialog", { name: "Connect your devices" }),
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Device name" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("Renamed phone");
  act(() => updateAppSettings({ language: "zh" }));
  expect(screen.getByRole("dialog", { name: "连接你的设备" })).toBeTruthy();
  fireEvent.blur(input);
  expect(rename).toHaveBeenCalledWith("phone", "Renamed phone");
});

it("shows fixture devices without requiring a Host and keeps preview actions local", async () => {
  window.history.replaceState(null, "", "/?preview=1");
  __resetAppSettingsForTests(JSON.stringify({ language: "en" }));
  vi.stubGlobal("ompStudioWebAccess", undefined);
  renderAccess();
  fireEvent.click(screen.getByRole("switch", { name: "Show Web control bar" }));
  expect(screen.getByRole("complementary", { name: "Host control" })).toBeTruthy();
  expect(getAppSettings().webAccessVisible).toBe(false);
  expect(localStorage.getItem("omp.appSettings")).toBe('{"language":"en"}');
  fireEvent.click(screen.getByRole("button", { name: /^Web access$/ }));
  expect(screen.getByDisplayValue("My laptop")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
  expect(screen.queryByDisplayValue("My laptop")).toBeNull();
});

it("keeps control and takeover available through settings when the bar is hidden", async () => {
  __resetAppSettingsForTests(JSON.stringify({ language: "en" }));
  let controlListener: Parameters<WebAccessApi["onControl"]>[0] | undefined;
  let owner = { id: "desktop", name: "Desktop" };
  const takeControl = vi.fn(async () => {
    owner = { id: "desktop", name: "Desktop" };
    return { version: "2", owner };
  });
  const api: WebAccessApi = {
    status: async () => ({ deviceId: "desktop", origin: "http://127.0.0.1:8560", addresses: [], devices: [], control: { version: "1", owner } }),
    takeControl,
    pair: async () => ({ url: "", qr: "", expiresAt: 0 }),
    revoke: async () => {},
    rename: async () => {},
    listen: async () => api.status(),
    exportCertificate: async () => true,
    onControl: listener => { controlListener = listener; return () => { controlListener = undefined; }; },
  };
  vi.stubGlobal("ompStudioWebAccess", api);
  const first = renderAccess();
  await waitFor(() => expect(screen.getByLabelText("Writable").textContent).toBe("true"));
  fireEvent.click(screen.getByRole("switch", { name: "Show Web control bar" }));
  expect(getAppSettings().webAccessVisible).toBe(true);
  const stored = localStorage.getItem("omp.appSettings");
  first.unmount();
  __resetAppSettingsForTests(stored);
  renderAccess();
  expect(screen.getByRole("complementary", { name: "Host control" })).toBeTruthy();
  await screen.findByText("You have control");
  fireEvent.click(screen.getByRole("button", { name: "Hide Web control bar" }));
  expect(getAppSettings().webAccessVisible).toBe(false);
  expect(screen.queryByRole("complementary", { name: "Host control" })).toBeNull();
  owner = { id: "phone", name: "Phone" };
  await act(async () => { controlListener?.({ version: "2", owner }); });
  expect(screen.getByLabelText("Writable").textContent).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Manage Web access" }));
  expect(await screen.findByText("Phone has control")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(takeControl).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByLabelText("Writable").textContent).toBe("true"));
  expect(screen.queryByRole("complementary", { name: "Host control" })).toBeNull();
  act(() => updateAppSettings({ language: "zh" }));
  expect(screen.getByRole("switch", { name: "显示 Web 控制条" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("此设备正在控制")).toBeTruthy();
  act(() => updateAppSettings({ language: "en" }));
  expect(screen.getByText("You have control")).toBeTruthy();
});
