import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerModelMenu } from "./ComposerModelPicker";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { createPreviewModelConfig } from "./preview/modelConfigFixtures";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

afterEach(() => { cleanup(); localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); });
it("excludes a Judge model from role shortcuts as well as the full chat model list", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const data = createPreviewModelConfig(false);
  const choose = vi.fn();
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><ComposerModelMenu data={data} loading={false} loadError={null} preview={false} isRoleSelected={() => false} isModelSelected={() => false} onChooseRole={choose} onChooseModel={() => {}} onClose={() => {}} /></PreviewModeProvider></I18nProvider>);
  expect(data.roles.some(role => role.id === "judge" && role.primary === "liquid/d1.1")).toBe(true);
  expect(screen.queryByRole("menuitemradio", { name: /@judge/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitemradio", { name: /@default/ }));
  expect(choose).toHaveBeenCalledWith(data.roles.find(role => role.id === "default"));
  fireEvent.click(screen.getByRole("button", { name: /More models/i }));
  expect(screen.queryByRole("option", { name: /d1\.1/ })).toBeNull();
});
