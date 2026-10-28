import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BtwPanel } from "./BtwPanel";
import { useBtwSession } from "./useBtwSession";
import { snapshotFromTextAndImages } from "../composer/serialize";
import { I18nProvider } from "../i18n";

afterEach(cleanup);

it("keeps the BTW text and image draft across docking and clears it for a new topic", async () => {
  const ask = vi.fn(async () => false);
  const image = { type: "image" as const, mimeType: "image/png" as const, data: "aW1hZ2U=" };
  function Surface() {
    const session = useBtwSession({ snapshot: null, client: null, preview: true, canCommand: false });
    const [placement, setPlacement] = useState(0);
    return <>
      <button onClick={() => session.setComposerDraft!(snapshotFromTextAndImages("keep this", [image]))}>Seed</button>
      <button onClick={() => setPlacement(value => value + 1)}>Dock</button>
      <button onClick={() => session.newTopic!()}>Reset topic</button>
      <BtwPanel key={placement} session={{ ...session, ask }} />
    </>;
  }
  render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Seed" }));
  fireEvent.click(screen.getByRole("button", { name: "Dock" }));
  expect(screen.getByRole("textbox").textContent).toContain("keep this");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(ask).toHaveBeenCalledWith(expect.stringContaining("keep this"), false, [image]);
  fireEvent.click(screen.getByRole("button", { name: "Reset topic" }));
  expect(screen.getByRole("textbox").textContent).toBe("");
});
