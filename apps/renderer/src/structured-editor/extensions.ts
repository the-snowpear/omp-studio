import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { lintGutter, lintKeymap, linter } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import type { StructuredLanguage } from "./parse";
import { yamlDiagnostics } from "./parse";
import { studioEditorTheme } from "./theme";

export function coreEditorExtensions(options: {
  placeholder?: string;
}): Extension[] {
  const extras: Extension[] = [];
  if (options.placeholder) extras.push(placeholder(options.placeholder));
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    indentUnit.of("  "),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    Prec.highest(keymap.of(historyKeymap)),
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...lintKeymap,
    ]),
    studioEditorTheme(),
    EditorView.contentAttributes.of({ spellcheck: "false" }),
    ...extras,
  ];
}

export function languageExtensions(
  language: StructuredLanguage,
  options: { allowEmpty: boolean; lint: boolean },
): Extension {
  const lang = language === "json" ? json() : yaml();
  if (!options.lint) return lang;
  const source =
    language === "json"
      ? (view: EditorView) => {
          if (options.allowEmpty && !view.state.doc.toString().trim()) return [];
          return jsonParseLinter()(view);
        }
      : (view: EditorView) => {
          try {
            return yamlDiagnostics(view.state.doc.toString(), options.allowEmpty);
          } catch (error) {
            const message = error instanceof Error ? error.message : "YAML 无法解析";
            return [{ from: 0, to: 0, severity: "error" as const, message, source: "yaml" }];
          }
        };
  return [lang, lintGutter(), linter(source, { delay: 300 })];
}
