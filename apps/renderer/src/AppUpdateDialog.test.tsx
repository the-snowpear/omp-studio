import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdateDialog } from "./AppUpdateDialog";
import { I18nProvider } from "./i18n/I18nContext";

describe("AppUpdateDialog", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  const mockUpdate = {
    currentVersion: "0.1.0",
    version: "0.2.0",
    name: "OMP Studio 0.2.0",
    releaseNotes: "### Changes\n- GitHub Releases support",
    publishedAt: "2026-08-20T00:00:00Z",
    htmlUrl: "https://github.com/the-snowpear/omp-studio/releases/tag/v0.2.0",
    downloadUrl: "https://github.com/the-snowpear/omp-studio/releases/download/v0.2.0/setup.exe",
    assetSize: 10485760, // 10 MB
  };

  it("renders update information accurately", () => {
    render(
      <I18nProvider forcedLanguage="zh">
        <AppUpdateDialog update={mockUpdate} onClose={vi.fn()} />
      </I18nProvider>,
    );

    expect(screen.getByText("OMP Studio 0.2.0")).toBeDefined();
    expect(screen.getByText("v0.1.0")).toBeDefined();
    expect(screen.getByText("v0.2.0")).toBeDefined();
    expect(screen.getByText(/GitHub Releases support/)).toBeDefined();
    expect(screen.getByText("下载并安装")).toBeDefined();
  });

  it("triggers download and install on button click", async () => {
    const handleDownload = vi.fn().mockResolvedValue(true);
    render(
      <I18nProvider forcedLanguage="zh">
        <AppUpdateDialog
          update={mockUpdate}
          onClose={vi.fn()}
          onDownloadAndInstall={handleDownload}
        />
      </I18nProvider>,
    );

    const downloadBtn = screen.getByText("下载并安装");
    fireEvent.click(downloadBtn);
    expect(handleDownload).toHaveBeenCalled();
  });

  it("triggers close on escape or cancel button", () => {
    const handleClose = vi.fn();
    render(
      <I18nProvider forcedLanguage="zh">
        <AppUpdateDialog update={mockUpdate} onClose={handleClose} />
      </I18nProvider>,
    );

    const cancelBtn = screen.getByText("稍后提醒");
    fireEvent.click(cancelBtn);
    expect(handleClose).toHaveBeenCalled();
  });
});
