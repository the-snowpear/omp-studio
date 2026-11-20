import { memo, useEffect, useMemo, useRef } from "react";
import { isPrimaryModifier } from "../keyboard/shortcuts";
import { MarkdownText } from "../conversation/markdown";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { PlanDocument, notesForSection, type PlanNote } from "./planDocument";
import { parsePlanSections, sectionBodyMarkdown } from "./planSections";

export const PlanAnnotatedBody = memo(function PlanAnnotatedBody({
  document, markdown, notes, disabled,
}: {
  document: PlanDocument;
  markdown: string;
  notes: readonly PlanNote[];
  disabled: boolean;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const sections = useMemo(() => parsePlanSections(markdown), [markdown]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftId = notes.find(note => note.draft !== undefined)?.id;
  useEffect(() => { if (draftId !== undefined) textareaRef.current?.focus(); }, [draftId]);

  const noteContent = (note: PlanNote, title: string) => <div key={note.id} className="plan-section-notes">
    {note.notes.map((text, index) => <div key={index} className="plan-note">
      <p className="plan-note-text">{text}</p>
      <button type="button" className="icon-btn small" disabled={disabled}
        aria-label={zh ? `删除批注 ${title} ${index + 1}` : `Delete annotation ${title} ${index + 1}`}
        onClick={() => document.editNote(note.id, { notes: note.notes.filter((_, i) => i !== index) })}>
        <Icon name="x" extra="sm" />
      </button>
    </div>)}
    {note.draft !== undefined ? <div className="plan-note-draft">
      <textarea ref={textareaRef} className="input" rows={3} value={note.draft} disabled={disabled}
        aria-label={zh ? `批注内容 ${title}` : `Annotation text ${title}`}
        placeholder={zh ? "写下对这一段的修改意见…" : "Write suggested edits for this section…"}
        onChange={event => document.editNote(note.id, { draft: event.target.value })}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); document.editNote(note.id, { draft: undefined });
          } else if (event.key === "Enter" && isPrimaryModifier(event)) {
            event.preventDefault(); event.stopPropagation(); document.flushNotes();
          }
        }} />
      <div className="plan-note-draft-actions">
        <button type="button" className="btn small outline" disabled={disabled}
          onClick={() => document.editNote(note.id, { draft: undefined })}>{zh ? "取消" : "Cancel"}</button>
        <button type="button" className="btn small primary" disabled={disabled || !note.draft.trim()}
          onClick={() => document.flushNotes()}>{zh ? "保存批注" : "Save annotation"}</button>
      </div>
    </div> : null}
  </div>;

  const orphaned = notes.filter(note => (note.notes.length || note.draft !== undefined)
    && (note.deleted || !sections.some(section => notesForSection([note], section).length > 0)));
  return <div className="plan-annotate">
    {sections.map((section, index) => {
      const title = section.title || (zh ? "计划前言" : "Plan preamble");
      const Heading = section.level === 0 ? "p" : `h${section.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const saved = notesForSection(notes, section);
      const count = saved.reduce((total, note) => total + note.notes.length, 0);
      const drafting = saved.some(note => note.draft !== undefined);
      const text = sectionBodyMarkdown(section);
      return <section key={index} className="plan-section">
        <div className="plan-section-head">
          <Heading className="plan-section-title"
            {...(section.level > 0 ? { "data-source-start": section.from,
              "data-source-end": section.from + section.raw.split("\n", 1)[0]!.replace(/\r$/, "").length } : {})}>{title}</Heading>
          <button type="button" className={`icon-btn plan-annotate-button${count ? " has-notes" : ""}`}
            disabled={disabled || drafting} aria-label={zh ? `批注 ${title}` : `Annotate ${title}`}
            data-tip={zh ? "添加批注" : "Add annotation"}
            onMouseDown={event => event.preventDefault()}
            onClick={event => {
              const selection = event.currentTarget.ownerDocument.getSelection();
              const container = event.currentTarget.closest("section");
              const quote = selection?.rangeCount && container?.contains(selection.getRangeAt(0).commonAncestorContainer)
                ? selection.toString().trim() : "";
              document.startNote(section, quote);
            }}>
            <Icon name="message" extra="sm" />
            {count ? <span className="plan-note-count" aria-hidden="true">{count}</span> : null}
          </button>
        </div>
        {text.trim() ? <div className="plan-section-body"><MarkdownText text={text} sourceOffset={section.bodyFrom} /></div> : null}
        {saved.map(note => noteContent(note, title))}
      </section>;
    })}
    {!markdown.trim() ? <p className="plan-empty">{zh ? "在上方开始编写计划，预览会实时显示在这里。" : "Start writing above. Your plan will appear here as you type."}</p> : null}
    {orphaned.map(note => <section key={note.id} className="plan-section plan-orphan-note">
      <div className="plan-orphan-title"><Icon name="message" extra="sm" /><strong>{note.title || (zh ? "计划前言" : "Plan preamble")}</strong><span>{zh ? "原章节已删除" : "Original section deleted"}</span></div>
      <details><summary>{zh ? "查看原文" : "View original text"}</summary><pre>{note.source}</pre></details>
      {noteContent(note, note.title)}
    </section>)}
  </div>;
});
