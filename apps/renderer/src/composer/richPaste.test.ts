import { describe, expect, it } from "vitest";
import { richPasteFromHtml, richPasteHasText } from "./richPaste";

const text = (html: string, plain = "") => {
  const paste = richPasteFromHtml(html, plain);
  return paste?.parts.map(part => part.kind === "text" ? part.text : `<${part.alt}>`).join("");
};

describe("rich paste", () => {
  it("turns a copied document into Markdown and drops unsafe links", () => {
    expect(text("<h2>Plan</h2><p>Ship <b>today</b>, see <a href='https://example.com/x'>notes</a> or <a href='javascript:alert(1)'>this</a>.</p><ul><li>one</li><li>two</li></ul>", "Plan Ship today, see notes or this. one two"))
      .toBe("## Plan\n\nShip **today**, see [notes](https://example.com/x) or this.\n\n- one\n- two");
  });

  it("keeps the plain paste when formatting adds nothing", () => {
    expect(richPasteFromHtml("<div><span>just words</span></div>", "just words")).toBeNull();
    expect(richPasteFromHtml("<p><b style='font-weight:normal'>Docs wrapper</b></p>", "Docs wrapper")).toBeNull();
    expect(richPasteFromHtml("<b>bold label</b>", "bold label")).toBeNull();
  });

  it("keeps pasted code verbatim in a fence", () => {
    expect(text("<pre class='language-ts'><code>const a = `x`;\n```</code></pre>", "const a = `x`;"))
      .toBe("````ts\nconst a = `x`;\n```\n````");
  });

  it("keeps table headers, body rows, and footer rows", () => {
    expect(text("<table><thead><tr><th>Name</th><th>Count</th></tr></thead><tbody><tr><td>apple</td><td>2</td></tr></tbody><tfoot><tr><td>Total</td><td>2</td></tr></tfoot></table>", "Name Count apple 2 Total 2"))
      .toBe("| Name | Count |\n| --- | --- |\n| apple | 2 |\n| Total | 2 |");
  });

  it("copies each nested table leaf only once", () => {
    let html = "<span>nested leaf</span>";
    for (let depth = 0; depth < 8; depth++) html = `<table><tr><td>${html}</td></tr></table>`;
    expect(text(html)?.match(/nested leaf/gu)).toHaveLength(1);
  });

  it("turns an SVG data image into an attachment rather than a missing file slot", () => {
    const data = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
    const paste = richPasteFromHtml(`<img alt="vector" src="data:image/svg+xml;base64,${data}">`, "");
    expect(paste).toEqual({
      parts: [{ kind: "image", image: { type: "image", mimeType: "image/svg+xml", data }, alt: "vector" }],
      slots: 0,
    });
  });

  it.each(["image/bmp", "image/tiff"])("keeps unsupported %s data images as clipboard file slots", mimeType => {
    const paste = richPasteFromHtml(`<img alt="unsupported" src="data:${mimeType};base64,AAAA">`, "");
    expect(paste).toEqual({
      parts: [{ kind: "image", slot: 0, alt: "unsupported" }],
      slots: 1,
    });
  });

  it("places images in document order and asks clipboard files to fill local ones", () => {
    const paste = richPasteFromHtml("<p>before</p><img alt='inline' src='data:image/png;base64,AAAA'><p>middle</p><img alt='local' src='file:///C:/shot.png'><p>after</p>", "before middle after")!;
    expect(paste.slots).toBe(1);
    expect(paste.parts.map(part => part.kind === "image" ? part.slot === undefined ? `img:${part.image?.mimeType}` : `slot:${part.slot}` : part.text.trim())).toEqual(["before", "img:image/png", "middle", "slot:0", "after"]);
    expect(richPasteHasText(paste)).toBe(true);
  });
});
