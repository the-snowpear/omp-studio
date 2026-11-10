import { setAskText } from "../test/askEditor";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientInteraction, InteractionId, SessionId } from "@omp-studio/client-contract";
import { InteractionDeck } from "../InteractionDeck";
import { selectOption } from "../test/selectOption";

afterEach(cleanup);

function mountAsk(multiple = false) {
  const onRespond = vi.fn(() => Promise.resolve(true));
  const interaction: ClientInteraction = {
    kind: "ask", interactionId: "ask-flow" as InteractionId, sessionId: "s" as SessionId,
    leaseGeneration: 1, title: "Choose", acceptImages: true,
    questions: [{ id: "q", question: "Which approach?", multiple, options: [{ id: "a", label: "Keep" }, { id: "b", label: "Compress" }] }],
  };
  render(<InteractionDeck interaction={interaction} onRespond={onRespond} disabled={false} />);
  return onRespond;
}

it("makes a typed single answer visibly replace the selected option", async () => {
  const respond = mountAsk();
  fireEvent.click(screen.getByRole("radio", { name: "Keep" }));
  setAskText(screen.getByRole("textbox", { name: "自定义回答" }), "Another approach");
  expect(screen.getByRole("radio", { name: "Keep" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("radio", { name: "自定义回答选项" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith("submit", { results: [{ id: "q", selectedOptions: [], customInput: "Another approach" }] }));
});

it("choosing an option replaces custom text and clears a note tied to that custom answer", async () => {
  const respond = mountAsk();
  setAskText(screen.getByRole("textbox", { name: "自定义回答" }), "Other");
  setAskText(screen.getByRole("textbox", { name: "备注 / Note" }), "Only for Other");
  fireEvent.click(screen.getByRole("radio", { name: "Compress" }));
  expect(screen.getByRole("textbox", { name: "自定义回答" }).textContent).toBe("");
  expect(screen.getByRole("textbox", { name: "备注 / Note" }).textContent).toBe("");
  expect(screen.getByRole("radio", { name: "自定义回答选项" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("radio", { name: "Compress" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Compress" }));
  expect(screen.getByRole("radio", { name: "Compress" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith("submit", { results: [{ id: "q", selectedOptions: ["Compress"] }] }));
});

it("keeps multiple selections alongside a custom answer and its explicitly assigned note", async () => {
  const respond = mountAsk(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep" }));
  setAskText(screen.getByRole("textbox", { name: "备注 / Note" }), "Extra detail");
  fireEvent.click(screen.getByRole("checkbox", { name: "Compress" }));
  setAskText(screen.getByRole("textbox", { name: "自定义回答" }), "Also archive");
  for (const name of ["Keep", "Compress", "自定义回答选项"]) expect(screen.getByRole("checkbox", { name }).getAttribute("aria-checked")).toBe("true");
  selectOption(screen.getByRole("combobox", { name: "备注对象 / Note on" }), "自定义回答");
  expect(screen.getByRole("textbox", { name: "备注 / Note" }).textContent).toBe("Extra detail");
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith("submit", { results: [{ id: "q", selectedOptions: ["Keep", "Compress"], customInput: "Also archive", note: "Extra detail" }] }));
});

it("does not silently move an option note when its owner is deselected", () => {
  mountAsk(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep" }));
  setAskText(screen.getByRole("textbox", { name: "备注 / Note" }), "Only for Keep");
  fireEvent.click(screen.getByRole("checkbox", { name: "Compress" }));
  expect(screen.getByRole("textbox", { name: "备注 / Note" }).textContent).toBe("Only for Keep");
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep" }));
  expect(screen.getByRole("textbox", { name: "备注 / Note" }).textContent).toBe("");
});

it("selects image-only custom answers and clears their images when choosing an option", async () => {
  const respond = mountAsk();
  fireEvent.click(screen.getByRole("radio", { name: "Keep" }));
  const file = new File(["x"], "clipboard.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([0]).buffer });
  fireEvent.paste(screen.getByRole("textbox", { name: "自定义回答" }), { clipboardData: { files: [file] } });
  await screen.findByRole("button", { name: "预览图1" });
  await waitFor(() => expect((screen.getByRole("radio", { name: "Compress" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("radio", { name: "Keep" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("radio", { name: "自定义回答选项" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Compress" }));
  expect(screen.queryByRole("button", { name: "预览图1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith("submit", { results: [{ id: "q", selectedOptions: ["Compress"] }] }));
});
