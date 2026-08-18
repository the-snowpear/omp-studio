import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MarkdownText } from "../conversation/markdown";
import { Icon } from "../icons";
import { mergePlanDraft, type PlanNotesBySection } from "./planFeedback";
import { parsePlanSections, sectionBodyMarkdown } from "./planSections";

const PREAMBLE_LABEL = "计划前言";

function headingTag(level: number): "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  if (level <= 0) return "p";
  if (level === 1) return "h1";
  if (level === 2) return "h2";
  if (level === 3) return "h3";
  if (level === 4) return "h4";
  if (level === 5) return "h5";
  return "h6";
}

export type PlanAnnotatedBodyHandle = {
  flushDraft: () => Record<number, string[]>;
};

export const PlanAnnotatedBody = forwardRef<PlanAnnotatedBodyHandle, {
  body: string;
  notes: PlanNotesBySection;
  disabled?: boolean;
  onNotesChange: (notes: Record<number, string[]>) => void;
}>(function PlanAnnotatedBody({
  body,
  notes,
  disabled,
  onNotesChange,
}, ref) {
  const sections = parsePlanSections(body);
  const [draftIndex, setDraftIndex] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const flushDraft = () => {
    const next = mergePlanDraft(notes, draftIndex === undefined ? undefined : { index: draftIndex, text: draft });
    if (draftIndex !== undefined && draft.trim().length > 0) {
      onNotesChange(next);
      setDraftIndex(undefined);
      setDraft("");
    }
    return next;
  };

  useImperativeHandle(ref, () => ({ flushDraft }), [draft, draftIndex, notes, onNotesChange]);

  useEffect(() => {
    if (draftIndex === undefined) return;
    textareaRef.current?.focus();
  }, [draftIndex]);

  useEffect(() => {
    if (draftIndex === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setDraftIndex(undefined);
      setDraft("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draftIndex]);

  const setSectionNotes = (index: number, next: string[]) => {
    const copy: Record<number, string[]> = {};
    for (const [key, value] of Object.entries(notes)) {
      copy[Number(key)] = [...value];
    }
    if (next.length === 0) delete copy[index];
    else copy[index] = next;
    onNotesChange(copy);
  };

  const startDraft = (index: number) => {
    setDraftIndex(index);
    setDraft("");
  };

  const saveDraft = () => {
    if (draftIndex === undefined) return;
    const note = draft.trim();
    if (!note) return;
    setSectionNotes(draftIndex, [...(notes[draftIndex] ?? []), note]);
    setDraftIndex(undefined);
    setDraft("");
  };

  const cancelDraft = () => {
    setDraftIndex(undefined);
    setDraft("");
  };

  return (
    <div className="plan-annotate">
      {sections.map((section, index) => {
        const title = section.title || PREAMBLE_LABEL;
        const Heading = headingTag(section.level);
        const markdown = sectionBodyMarkdown(section).trim();
        const saved = notes[index] ?? [];
        const drafting = draftIndex === index;
        return (
          <section key={`${index}:${section.title}`} className="plan-section">
            <div className="plan-section-head">
              <Heading className="plan-section-title">{title}</Heading>
              <button
                type="button"
                className="btn small outline"
                disabled={disabled === true || drafting}
                aria-label={`批注 ${title}`}
                onClick={() => startDraft(index)}
              >
                批注
              </button>
            </div>
            {markdown.length > 0 ? (
              <div className="plan-section-body">
                <MarkdownText text={markdown} />
              </div>
            ) : null}
            {saved.map((note, noteIndex) => (
              <div key={`${noteIndex}:${note}`} className="plan-note">
                <p className="plan-note-text">{note}</p>
                <button
                  type="button"
                  className="icon-btn small"
                  disabled={disabled === true}
                  aria-label={`删除批注 ${title} ${noteIndex + 1}`}
                  onClick={() => setSectionNotes(index, saved.filter((_, i) => i !== noteIndex))}
                >
                  <Icon name="x" extra="sm" />
                </button>
              </div>
            ))}
            {drafting ? (
              <div className="plan-note-draft">
                <textarea
                  ref={textareaRef}
                  className="input"
                  rows={3}
                  value={draft}
                  disabled={disabled === true}
                  aria-label={`批注内容 ${title}`}
                  placeholder="写下对这一段的修改意见…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      saveDraft();
                    }
                  }}
                />
                <div className="plan-note-draft-actions">
                  <button type="button" className="btn small outline" disabled={disabled === true} onClick={cancelDraft}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={disabled === true || draft.trim().length === 0}
                    onClick={saveDraft}
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
});
