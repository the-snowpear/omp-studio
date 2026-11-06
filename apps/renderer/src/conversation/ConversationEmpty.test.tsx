import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { ConversationEmpty } from "./ConversationEmpty";

afterEach(cleanup);

it("keeps the disconnected welcome free of reconnect and diagnostics actions", () => {
  render(
    <I18nProvider forcedLanguage="zh">
      <ConversationEmpty onOpenHistory={() => undefined} runtimeConnected={false} />
    </I18nProvider>,
  );
  expect(screen.getByText(/尚未连接 Runtime/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重新连接 Runtime" })).toBeNull();
  expect(screen.queryByRole("button", { name: "诊断中心" })).toBeNull();
});
