import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { UserMessageBody } from "./UserMessageBody";
import type { ComposerDoc } from "../composer/types";

afterEach(cleanup);

it("switches existing message image labels without changing the saved document or thumbnail", () => {
  const doc: ComposerDoc = { nodes: [{ type: "chip", chip: {
    id: "clipboard-image", kind: "image", label: "图1", image: { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  } }] };
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><UserMessageBody text="[图1]" doc={doc} /></I18nProvider>;
  const { container, rerender } = render(view("zh"));
  const source = container.querySelector("img")?.getAttribute("src");
  expect(container.textContent).toContain("图1");
  rerender(view("en"));
  expect(container.textContent).toContain("Img1");
  expect(container.textContent).not.toContain("图1");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(source);
  expect(doc.nodes[0]).toMatchObject({ chip: { id: "clipboard-image", label: "图1" } });
  rerender(view("zh"));
  expect(container.textContent).toContain("图1");
});
