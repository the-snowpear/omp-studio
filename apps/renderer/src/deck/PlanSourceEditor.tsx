import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { languages } from "@codemirror/language-data";
import { closeSearchPanel, getSearchQuery, openSearchPanel, SearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { useI18n } from "../i18n";
import { PlanDocument } from "./planDocument";

export type PlanSourceRange = { from: number; to: number };
const SEARCH_ZH = {
  Find: "查找", Replace: "替换", next: "下一处", previous: "上一处", all: "全选匹配", "match case": "区分大小写",
  regexp: "正则表达式", "by word": "全词匹配", replace: "替换", "replace all": "全部替换", close: "关闭查找",
  "Go to line": "跳转到行", go: "跳转", "Fold line": "折叠行", "Unfold line": "展开行", "folded code": "已折叠代码",
  unfold: "展开", "Folded lines": "已折叠行", "Unfolded lines": "已展开行", to: "至", "current match": "当前匹配",
  "on line": "位于行", "replaced match on line $": "已替换第 $ 行的匹配", "replaced $ matches": "已替换 $ 处匹配",
};
export const highlightPlanRange = StateEffect.define<PlanSourceRange | null>();
const linkedRange = StateField.define<PlanSourceRange | null>({
  create: () => null,
  update(value, transaction) {
    let next = transaction.docChanged ? null : value;
    for (const effect of transaction.effects) if (effect.is(highlightPlanRange)) next = effect.value;
    return next;
  },
  provide: field => EditorView.decorations.compute([field], state => {
    const range = state.field(field);
    if (!range) return Decoration.none;
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
    return Decoration.set(Array.from({ length: last - first + 1 }, (_, index) =>
      Decoration.line({ class: "plan-source-linked" }).range(state.doc.line(first + index).from)));
  }),
});

export function PlanSourceEditor({ document, disabled, onSave, onPosition, onCaret, onLeave, onScroll }: {
  document: PlanDocument;
  disabled: boolean;
  onSave: () => void;
  onPosition: (position: number) => void;
  onCaret: (position: number) => void;
  onLeave: (target: EventTarget | null) => void;
  onScroll: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const zh = useI18n().resolvedLanguage === "zh";
  const callbacks = useRef({ onSave, onPosition, onCaret, onLeave, onScroll });
  callbacks.current = { onSave, onPosition, onCaret, onLeave, onScroll };

  useLayoutEffect(() => {
    const parent = host.current!;
    const view = new EditorView({ parent, state: document.state,
      dispatchTransactions(transactions, editor) {
        editor.update(transactions);
        document.accept(transactions);
        if (transactions.some(transaction => transaction.selection) && !transactions.some(transaction => transaction.docChanged)) {
          callbacks.current.onCaret(editor.state.selection.main.head);
        }
      },
    });
    document.view = view;
    view.dispatch({ effects: document.ui.reconfigure([
      linkedRange,
      EditorView.scrollMargins.of(() => ({ top: 38, bottom: 10 })),
      Prec.highest(keymap.of([
        { key: "Mod-Enter", run: () => { callbacks.current.onSave(); return true; } },
        { key: "Mod-s", run: () => { callbacks.current.onSave(); return true; } },
      ])),
      EditorView.domEventHandlers({
        mousemove(event, editor) {
          if (event.buttons) return;
          const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position !== null) callbacks.current.onPosition(position);
        },
        mouseleave(event) { callbacks.current.onLeave(event.relatedTarget); },
        scroll() { callbacks.current.onScroll(); },
      }),
    ]) });
    view.scrollDOM.scrollTop = document.sourceScroll.top;
    view.scrollDOM.scrollLeft = document.sourceScroll.left;
    const observer = new ResizeObserver(() => { view.requestMeasure(); callbacks.current.onScroll(); });
    observer.observe(parent);
    return () => {
      document.sourceScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
      document.view = undefined;
      observer.disconnect();
      view.destroy();
    };
  }, [document]);

  useEffect(() => { document.view?.focus(); }, [document]);
  useEffect(() => {
    const view = document.view;
    const searching = view && searchPanelOpen(view.state);
    const focused = view?.dom.ownerDocument.activeElement;
    const input = focused instanceof HTMLInputElement && view?.dom.contains(focused) ? focused : null;
    const searchSelection = input ? { name: input.name, start: input.selectionStart, end: input.selectionEnd } : null;
    const searchInput = view?.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]');
    if (view && searching && searchInput) {
      // A pasted/composing query may still be waiting for CodeMirror's keyup/change.
      const query = getSearchQuery(view.state);
      const replacement = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: searchInput.value, replace: replacement?.value ?? query.replace,
        caseSensitive: query.caseSensitive, literal: query.literal, regexp: query.regexp, wholeWord: query.wholeWord })) });
    }
    document.dispatch({ effects: document.access.reconfigure([
      EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
      EditorState.phrases.of(zh ? SEARCH_ZH : {}),
      EditorView.contentAttributes.of({ "aria-label": zh ? "计划 Markdown" : "Plan Markdown", role: "textbox", "aria-multiline": "true", "aria-readonly": String(disabled) }),
    ]) });
    // CodeMirror's stock search panel captures phrases at creation. Recreate just
    // that panel; its query lives in editor state and the document is untouched.
    if (view && searching) {
      closeSearchPanel(view); openSearchPanel(view);
      if (searchSelection) {
        const field = view.dom.querySelector<HTMLInputElement>(`input[name="${searchSelection.name}"]`);
        field?.focus();
        if (field?.type === "text") field.setSelectionRange(searchSelection.start, searchSelection.end);
      } else if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
  }, [document, disabled, zh]);
  useEffect(() => {
    let active = true;
    void languages.find(language => language.name === "Markdown")!.load().then(extension => {
      if (active) document.dispatch({ effects: document.language.reconfigure(extension) });
    });
    return () => { active = false; };
  }, [document]);
  return <div ref={host} className="plan-source-editor" />;
}
