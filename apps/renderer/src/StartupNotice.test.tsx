import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupNotice, StartupNoticeDialog } from "./StartupNotice";
import {
  PROJECT_GITHUB_URL,
  STARTUP_NOTICE_COPY,
  STARTUP_NOTICE_ID,
  STARTUP_NOTICE_STORAGE_KEY,
  __resetStartupNoticeForTests,
  dismissStartupNoticeForever,
  shouldShowStartupNotice,
} from "./settings/startupNotice";

const originalOpen = window.open;

afterEach(() => {
  cleanup();
  __resetStartupNoticeForTests();
  window.open = originalOpen;
  Reflect.deleteProperty(globalThis, "ompStudioChrome");
});

describe("startupNotice persistence", () => {
  it("shows until the current notice version is dismissed forever", () => {
    expect(shouldShowStartupNotice()).toBe(true);
    dismissStartupNoticeForever();
    expect(shouldShowStartupNotice()).toBe(false);
    expect(window.localStorage.getItem(STARTUP_NOTICE_STORAGE_KEY)).toBe(STARTUP_NOTICE_ID);
  });

  it("shows again after a different stored version", () => {
    window.localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, "older");
    expect(shouldShowStartupNotice()).toBe(true);
  });
});

describe("StartupNoticeDialog", () => {
  it("shows Chinese incomplete copy and the project GitHub address", () => {
    render(<StartupNoticeDialog onClose={() => undefined} onDontRemind={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: STARTUP_NOTICE_COPY.title });
    expect(dialog.closest(".modal-backdrop")?.parentElement).toBe(document.body);
    expect(screen.getByText(STARTUP_NOTICE_COPY.kicker)).toBeTruthy();
    expect(screen.getByText(STARTUP_NOTICE_COPY.body)).toBeTruthy();
    expect(screen.getByText(STARTUP_NOTICE_COPY.hint)).toBeTruthy();
    expect(screen.getByText(STARTUP_NOTICE_COPY.thanks)).toBeTruthy();
    const repo = screen.getByRole("link", { name: `${STARTUP_NOTICE_COPY.repoLabel} ${PROJECT_GITHUB_URL}` });
    expect(repo.getAttribute("href")).toBe(PROJECT_GITHUB_URL);
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "不再提醒" })).toBeTruthy();
  });

  it("closes from the footer, header, backdrop, and Escape without persisting", () => {
    const closed: string[] = [];
    render(
      <StartupNoticeDialog onClose={() => closed.push("close")} onDontRemind={() => closed.push("forever")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    fireEvent.mouseDown(screen.getByRole("dialog").closest(".modal-backdrop")!);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["close", "close", "close", "close"]);
    expect(shouldShowStartupNotice()).toBe(true);
  });

  it("copies the GitHub URL from the copy control", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<StartupNoticeDialog onClose={() => undefined} onDontRemind={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "复制项目地址" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(PROJECT_GITHUB_URL);
      expect(screen.getByRole("button", { name: "已复制项目地址" })).toBeTruthy();
    });
  });

  it("opens the GitHub card through chrome openUrl instead of window.open", () => {
    const openUrl = vi.fn(async () => undefined);
    const opened: string[] = [];
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    globalThis.ompStudioChrome = { openUrl } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;
    render(<StartupNoticeDialog onClose={() => undefined} onDontRemind={() => undefined} />);
    fireEvent.click(screen.getByRole("link", { name: `${STARTUP_NOTICE_COPY.repoLabel} ${PROJECT_GITHUB_URL}` }));
    expect(openUrl).toHaveBeenCalledWith({ url: PROJECT_GITHUB_URL });
    expect(opened).toEqual([]);
  });
});

describe("StartupNotice", () => {
  it("hides for this session after 关闭 and returns on remount", () => {
    const { unmount } = render(<StartupNotice />);
    expect(screen.getByRole("dialog", { name: STARTUP_NOTICE_COPY.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: STARTUP_NOTICE_COPY.title })).toBeNull();
    unmount();
    render(<StartupNotice />);
    expect(screen.getByRole("dialog", { name: STARTUP_NOTICE_COPY.title })).toBeTruthy();
  });

  it("does not return after 不再提醒", () => {
    const { unmount } = render(<StartupNotice />);
    fireEvent.click(screen.getByRole("button", { name: "不再提醒" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(shouldShowStartupNotice()).toBe(false);
    unmount();
    render(<StartupNotice />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
