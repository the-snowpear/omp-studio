import { expect, it } from "vitest";
import { common, createLowlight } from "lowlight";
import { computeHighlight } from "./compute";
import { validateTokens } from "./protocol";

it("preserves the common grammars' text and class structure, including aliases and embedded languages", () => {
  const lowlight = createLowlight(common);
  const fixtures = [
    ["ts", 'export class App extends Base { run(x: number) { return "hello" + x; } }\n'],
    ["python", '@decorator\ndef greet(name):\n    print(f"Hello {name}")\n'],
    ["html", '<script>const x = 1;</script><style>a {color: red}</style>'],
    ["sql", 'SELECT * FROM users WHERE id = 5;'], ["json", '{"name": "值", "ok": true}'],
    ["bash", 'echo "$PATH" # note'], ["markdown", '# Title\n**strong** and *emphasis*'],
  ];
  const normalize = (nodes: ReturnType<typeof lowlight.highlight>["children"]): unknown[] => nodes.map((node): unknown => {
    if (node.type === "text") return { type: "text", value: node.value };
    if (node.type !== "element") throw new Error("unexpected node");
    return { type: "span", classes: node.properties.className, children: normalize(node.children) };
  });
  for (const [language, code] of fixtures) {
    const actual = computeHighlight(language!, code!);
    expect(actual).toEqual(normalize(lowlight.highlight(language!, code!).children));
    expect(validateTokens(actual, code!)).toBe(true);
  }
  expect(() => computeHighlight("unknown-language", "x")).toThrow();
});
