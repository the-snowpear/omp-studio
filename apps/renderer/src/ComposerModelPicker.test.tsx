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

it("shows a model's full selector and keeps thinking levels in the open picker when language changes", () => {
  const data = createPreviewModelConfig(false);
  const name = "a-long-model-name-with-a-release-suffix";
  const selector = `provider/${name}`;
  const models = { ...data, availableModels: [...data.availableModels, {
    provider: "provider", id: name, name, selector, reasoning: true,
    thinkingConfig: { mode: "effort" as const, requiresEffort: false, efforts: ["low", "high"] as const },
  }] };
  const menu = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}>
    <PreviewModeProvider>
      <ComposerModelMenu data={models} loading={false} loadError={null} preview={false}
        isRoleSelected={() => false} isModelSelected={() => false}
        onChooseRole={() => {}} onChooseModel={() => {}} onClose={() => {}} />
    </PreviewModeProvider>
  </I18nProvider>;
  const view = render(menu("en"));
  fireEvent.click(screen.getByRole("button", { name: /More models/i }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: selector } });
  const option = screen.getByRole("option", { name: new RegExp(selector) });
  expect(screen.getByText(selector)).toBeTruthy();
  expect(option.textContent).toContain("Off · low · high");
  view.rerender(menu("zh"));
  expect(option.textContent).toContain("关闭 · low · high");
  view.rerender(menu("en"));
  expect(option.textContent).toContain("Off · low · high");
});
