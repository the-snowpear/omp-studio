import { cleanup,fireEvent,render,screen } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { SessionImportPanel } from "./SessionImportPanel";
import { RuntimeCredentials } from "./models/RuntimeCredentials";
import { displayDocFromSerializedText,serializeDoc,snapshotFromTextAndImages } from "./composer/serialize";
import { mentionAtCaret } from "./composer/editorDom";
afterEach(()=>{cleanup();localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);});
it("model selectors survive display and queue serialization without spawning agents",()=>{
 const text="review with ^openai/gpt-test and ^custom/deepseek:0731";
 const doc=displayDocFromSerializedText(text);
 expect(doc.nodes.filter(node=>node.type==="chip").map(node=>node.type==="chip"?node.chip.kind:"")).toEqual(["model","model"]);
 expect(serializeDoc(doc).text).toBe(text);
 expect(snapshotFromTextAndImages(text).doc.nodes.filter(node=>node.type==="chip")).toHaveLength(2);
});
it("caret recognizes model mentions separately from file mentions",()=>{
 const editor=document.createElement("div");editor.contentEditable="true";const node=document.createTextNode("ask ^openai/model");editor.append(node);document.body.append(editor);
 const selection=window.getSelection()!;const range=document.createRange();range.setStart(node,node.length);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
 expect(mentionAtCaret(editor)).toMatchObject({trigger:"^",query:"openai/model"});editor.remove();
});
it("preview import creates only a local result and does not open a real session",async()=>{
 localStorage.setItem(PREVIEW_MODE_STORAGE_KEY,"1");const open=vi.fn();
 render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="en"><SessionImportPanel client={null} onOpen={open}/></I18nProvider></PreviewModeProvider>);
 fireEvent.click(screen.getByRole("button",{name:"Import Claude / Codex sessions"}));
 fireEvent.click(await screen.findByRole("button",{name:/检查 SessionChanges/}));
 fireEvent.click(await screen.findByRole("button",{name:"Import"}));
 expect(await screen.findByText("Imported. The source file is unchanged.")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Open"}));expect(open).not.toHaveBeenCalled();
});
it("credential preview uses masked input and clears entered keys after local save",()=>{
 render(<I18nProvider forcedLanguage="en"><RuntimeCredentials client={null} preview/></I18nProvider>);
 const input=screen.getByLabelText("typesafe API key") as HTMLInputElement;expect(input.type).toBe("password");
 fireEvent.change(input,{target:{value:"demo-key"}});fireEvent.click(screen.getByRole("button",{name:"Save"}));expect(input.value).toBe("");
});
