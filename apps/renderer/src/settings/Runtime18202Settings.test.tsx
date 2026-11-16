import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { FeatureSettingRow } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { FeatureSettingsPane } from "./FeatureSettingsPane";
import { BashRulesEditor } from "./BashRulesEditor";

const manifest = { profile: "limited" as const, generatedAt: "2026-11-15", hash: "settings-layers", capabilities: ["preferences.features.get", "preferences.features.set", "preferences.features.clearOverride"].map(id => ({ id, grade: "stable" as const, version: 1, evidence: "test" })) };
const context = { available: true, sessionId: "settings", capabilities: manifest };
afterEach(() => { cleanup(); localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); });

function mountRows(rows: FeatureSettingRow[], group: "shell" | "auxiliary" = "shell") {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const receipts: Record<string, unknown> = {};
  let serial = 0;
  const command = vi.fn(async (kind: string, input: Record<string, unknown>) => {
    const requestId = `setting-${++serial}`;
    const row = rows.find(item => item.key === input.key);
    const result = kind === "preferences.features.get" ? { settings: rows } : { ...row, value: input.value, source: "global", ...(row?.editableValues ? { editableValues: { ...row.editableValues, global: input.value } } : {}) };
    receipts[requestId] = { status: "completed", result: { result } };
    return { requestId };
  });
  const client = { command, getState: () => ({ commands: receipts }), subscribe: () => () => {} } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><FeatureSettingsPane client={client} context={context} group={group} visible /></PreviewModeProvider></I18nProvider>);
  return command;
}

it("saves authored global Bash rules without promoting project rules or flattening path groups", async () => {
  const projectRule = { match: "project-only*", approval: "allow" };
  const globalRule = { match: "global-status*", approval: "allow" };
  const scoped = { paths: ["/workspace/a"], values: [{ match: "scoped-only*", approval: "allow" }] };
  const command = mountRows([{ key: "bash.patterns", source: "project", value: [projectRule, globalRule], editableValues: { global: [globalRule, scoped], session: null } }]);
  const pattern = await screen.findByRole("textbox", { name: "Rule 1 command pattern" });
  expect((pattern as HTMLInputElement).value).toBe("global-status*");
  expect(screen.queryByDisplayValue("project-only*")).toBeNull();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Rule 1 approval" })).getByRole("radio", { name: "Ask" }));
  fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("preferences.features.set", {
    sessionId: "settings", key: "bash.patterns", scope: "global",
    value: [{ ...globalRule, approval: "prompt" }, scoped],
  }));
});

it("keeps inline path restrictions when editing an authored rule", () => {
  const scoped = { match: "scoped*", approval: "allow", pathPrefix: "/workspace/a", env: ["CI"] };
  const save = vi.fn();
  render(<BashRulesEditor value={[scoped]} disabled={false} zh={false} label="rules" save={save} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Rule 1 command pattern" }), { target: { value: "scoped-status*" } });
  fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
  expect(save).toHaveBeenCalledWith([{ ...scoped, match: "scoped-status*" }]);
});

it("does not write merged rules when an older Runtime lacks authored layers", async () => {
  const command = mountRows([{ key: "bash.patterns", source: "project", value: [{ match: "project-only*", approval: "allow" }] }]);
  const pattern = await screen.findByRole("textbox", { name: "Rule 1 command pattern" });
  expect((pattern as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(true);
  expect(command.mock.calls.every(([kind]) => kind === "preferences.features.get")).toBe(true);
});

it.each([
  ["shellPath", "Shell executable", "shell"],
  ["find.verifyModel", "Find verification model", "auxiliary"],
] as const)("can clear the optional native %s setting", async (key, label, group) => {
  const command = mountRows([{ key, value: "custom-value", source: "global" }], group);
  const input = await screen.findByRole("textbox", { name: label });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("custom-value"));
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(within(input.closest(".feature-number")!).getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("preferences.features.set", { sessionId: "settings", key, scope: "global", value: "" }));
});
