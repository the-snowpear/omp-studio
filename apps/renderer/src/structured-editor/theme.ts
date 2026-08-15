import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** Syntax colors come from design tokens so light/dark follow `html[data-theme]`. */
export function studioEditorTheme(): Extension {
  return [
    EditorView.theme({
      "&": {
        height: "100%",
        backgroundColor: "var(--code-bg)",
        color: "var(--text-2)",
        fontSize: "var(--fs-11)",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "var(--font-mono)",
        lineHeight: "1.7",
      },
      ".cm-content": {
        caretColor: "var(--accent)",
        padding: "12px 0",
        minHeight: "100%",
      },
      ".cm-line": { padding: "0 16px" },
      ".cm-gutters": {
        backgroundColor: "var(--code-bg)",
        color: "var(--text-faint)",
        borderRight: "1px solid var(--border)",
      },
      ".cm-gutterElement": { padding: "0 8px" },
      ".cm-activeLine": { backgroundColor: "var(--surface-hover)" },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--surface-hover)",
        color: "var(--text-3)",
      },
      ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "var(--selection) !important",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      ".cm-foldPlaceholder": {
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        color: "var(--text-3)",
        margin: "0 4px",
        padding: "0 6px",
        borderRadius: "var(--r-4)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-6)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
      },
      ".cm-tooltip-hover": { padding: "6px 8px" },
      ".cm-diagnostic": { padding: "3px 6px" },
      ".cm-diagnostic-error": { borderLeftColor: "var(--red)" },
      ".cm-diagnostic-warning": { borderLeftColor: "var(--amber)" },
      ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--red)" },
      ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--amber)" },
      ".cm-lint-marker-error": { color: "var(--red)" },
      ".cm-lint-marker-warning": { color: "var(--amber)" },
      ".cm-panels": {
        backgroundColor: "var(--surface-2)",
        color: "var(--text)",
        borderTop: "1px solid var(--border)",
      },
      ".cm-panels-top": { borderBottom: "1px solid var(--border)", borderTop: "none" },
      ".cm-panel.cm-search": { padding: "6px 10px", gap: "6px" },
      ".cm-textfield": {
        background: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-4)",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--fs-12)",
        padding: "3px 8px",
      },
      ".cm-button": {
        background: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-6)",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--fs-11)",
        padding: "3px 8px",
        cursor: "pointer",
      },
      ".cm-button:hover": { background: "var(--surface-hover)" },
      ".cm-panel.cm-search label": { color: "var(--text-3)", fontSize: "var(--fs-11)" },
      ".cm-placeholder": { color: "var(--text-faint)", fontStyle: "italic" },
    }),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.comment, color: "var(--text-faint)", fontStyle: "italic" },
        { tag: tags.lineComment, color: "var(--text-faint)", fontStyle: "italic" },
        { tag: tags.blockComment, color: "var(--text-faint)", fontStyle: "italic" },
        { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], color: "var(--accent)" },
        { tag: tags.keyword, color: "var(--accent)" },
        { tag: tags.string, color: "var(--green)" },
        { tag: tags.number, color: "var(--blue)" },
        { tag: [tags.bool, tags.null, tags.atom, tags.literal], color: "var(--amber)" },
        { tag: tags.punctuation, color: "var(--text-3)" },
        { tag: tags.bracket, color: "var(--text-3)" },
        { tag: tags.separator, color: "var(--text-3)" },
        { tag: tags.operator, color: "var(--text-2)" },
        { tag: tags.meta, color: "var(--text-3)" },
        { tag: tags.invalid, color: "var(--red)" },
      ]),
    ),
  ];
}
