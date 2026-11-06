import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  await waitFor(() => expect(ask).toHaveBeenCalledWith(expect.stringContaining("keep this"), false, [image]));
  fireEvent.click(screen.getByRole("button", { name: "Reset topic" }));
  expect(screen.getByRole("textbox").textContent).toBe("");
});

it("stops an answer without submitting the follow-up draft when the send button returns", () => {
  const ask = vi.fn(async () => false);
  function Surface() {
    const [running, setRunning] = useState(true);
    const session = useBtwSession({
      snapshot: { ephemeralId: "answer", status: running ? "running" : "aborted", text: "Partial answer" },
      client: null, preview: true, canCommand: false,
    });
    return <>
      <button onClick={() => session.setDraft("Follow up later")}>Seed</button>
      <BtwPanel session={{ ...session, ask, abort: async () => { setRunning(false); } }} />
    </>;
  }
  render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Seed" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(ask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "停止回答" }));
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
  expect(ask).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox").textContent).toContain("Follow up later");
});

it("shows an unsupported attachment error instead of silently dropping the file", async () => {
  function Surface() {
    const session = useBtwSession({ snapshot: null, client: null, preview: true, canCommand: false });
    return <BtwPanel session={session} />;
  }
  const { container } = render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(["file contents"], "notes.txt", { type: "text/plain" })] },
  });
  expect((await screen.findByRole("alert")).textContent).toContain("只有图片可以附件");
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
});

for (const cancelled of [false, true]) {
  it(cancelled ? "does not attach a late image to a different topic" : "waits for pasted images and sends a queued Enter only once", async () => {
    const image = { type: "image" as const, mimeType: "image/png" as const, data: "aW1hZ2U=" };
    let complete!: (images: typeof image[]) => void;
    const loading = new Promise<typeof image[]>(resolve => { complete = resolve; });
    const ask = vi.fn(async () => true);
    const resolveImagePaste = vi.fn(() => loading);
    function Surface() {
      const session = useBtwSession({ snapshot: null, client: null, preview: true, canCommand: false });
      return <BtwPanel session={{ ...session, ask, resolveImagePaste }} />;
    }
    render(<I18nProvider forcedLanguage="zh"><Surface /></I18nProvider>);
    const editor = screen.getByRole("textbox");
    editor.textContent = "Look at this"; fireEvent.input(editor);
    fireEvent.paste(editor, { clipboardData: { files: [], getData: () => '"C:\\images\\screen.png"' } });
    fireEvent.keyDown(editor, { key: "Enter" }); fireEvent.keyDown(editor, { key: "Enter" });
    expect(ask).not.toHaveBeenCalled();
    if (cancelled) fireEvent.click(screen.getByRole("button", { name: "新话题" }));
    await act(async () => { complete([image]); await loading; });
    if (cancelled) { expect(ask).not.toHaveBeenCalled(); expect(editor.textContent).toBe(""); }
    else {
      await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
      expect(ask).toHaveBeenCalledWith(expect.stringContaining("Look at this"), false, [image]);
    }
  });
}
