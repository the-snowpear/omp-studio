import { AppSelect } from "../AppSelect";
import { MarkdownInline } from "../conversation/markdown";
import { useI18n } from "../i18n";
import { PLATFORM } from "../platform";
import {useState,useEffect,useRef,useId} from "react";
import type { ChipComposerHandle } from "../composer/ChipComposer";
import {AskImages} from "./AskImages";
import { PromptHead, type DeckQueue } from "./PromptHead";
import { askAnswered, askNoteOption, hasCustomAnswer } from "./askContent";
import type { AskHeader, DeckAskAnswer, DeckAskQuestion } from "./types";

/** 常驻标题行：换页时高亮胶囊与 1/N 就地更新，行本身不重建、不平移。 */
export function AskHead({
  demo,
  meta,
  queue,
  headers,
  onJump,
  onCollapse,
}: {
  demo?: boolean;
  meta?: string;
  queue?: DeckQueue;
  /** 本批次全部 ask 的 header 胶囊（含当前卡）；多张 ask 时才显示。 */
  headers: readonly AskHeader[];
  onJump: (index: number) => void;
  onCollapse?: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return (
    <PromptHead
      icon="message"
      title={zh ? "Agent 提问" : "Agent question"}
      {...(onCollapse ? { end: <button type="button" className="btn small ghost" onClick={onCollapse} data-tip={PLATFORM === "darwin" ? "⌥H" : "Alt+H"}>{zh ? "收起 / Hide" : "Hide"}</button> } : {})}
      {...(demo === true ? { demo: true } : {})}
      {...(meta ? { meta } : {})}
      {...(queue ? { queue } : {})}
      {...(headers.length > 1 ? {
        chips: (
          <span className="dk-head-chips" role="tablist" aria-label={zh ? "问题" : "Questions"}>
            {headers.map((entry) => (
              <button
                key={`${entry.index}:${entry.header}`}
                type="button"
                role="tab"
                aria-selected={entry.active}
                className={`dk-head-chip${entry.active ? " active" : ""}`}
                data-dk-focus={`chip:${entry.index}`}
                onClick={() => onJump(entry.index)}
              >
                {entry.header}
              </button>
            ))}
          </span>
        ),
      } : {})}
    />
  );
}

/** 换页时唯一会动的那一段：问题正文 + 选项 + 自定义回答。 */
export function AskBody({
  question, answer, disabled, onPick, onChoose, onCustom, onPatch, onSubmit, onBusy,
}: {
  onBusy?: (busy: boolean) => void;
  question: DeckAskQuestion;
  answer: DeckAskAnswer;
  disabled?: boolean;
  onPick: (label: string) => void;
  /** Toggle lists answer a click immediately instead of staging it. */
  onChoose?: (label: string) => void;
  onCustom: (value: string) => void;
  onPatch?: (patch: Partial<DeckAskAnswer>) => void;
  onSubmit: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [customBusy, setCustomBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [customEditing, setCustomEditing] = useState(false);
  const inputRef = useRef<ChipComposerHandle>(null);
  const noteId = useId();
  const hasCustom = hasCustomAnswer(answer);
  const exclusive = !question.multi || question.customExclusive === true;
  const customActive = hasCustom || (customEditing && exclusive);
  const picked = exclusive && hasCustom ? [] : answer.picked;
  const imagesAllowed = question.acceptImages === true && onPatch !== undefined;
  const choicesDisabled = disabled || customBusy || noteBusy;
  const noteDisabled = disabled || !askAnswered(answer);
  const owner = askNoteOption(answer);
  const noteOption = owner !== undefined && picked.includes(owner) ? owner : hasCustom ? undefined : picked[0];
  const noteTargetCount = picked.length + (hasCustom ? 1 : 0);
  useEffect(() => { onBusy?.(customBusy || noteBusy); return () => onBusy?.(false); }, [customBusy, noteBusy, onBusy]);

  const chooseCustom = () => {
    if (!exclusive && hasCustom) {
      setCustomEditing(false);
      onPatch?.({ custom: "", customInputImages: [] });
      return;
    }
    setCustomEditing(true);
    if (!hasCustom) onCustom("");
    inputRef.current?.focus();
  };

  return (
    <div className="ask-body">
      <div className="dk-sub"><MarkdownInline text={question.question} k={`q-${question.id}`} /></div>
      <p className="ask-selection-hint">
        {question.toggleList && onChoose
          ? (zh ? "点击切换勾选，每次点击都会立即发送；选完后点结束项" : "Click to toggle a mark; each click is sent right away. Pick the finishing row when done")
          : question.multi
          ? exclusive
            ? (zh ? "多选 · 自定义回答会替代已选项" : "Multi-select · Custom answer replaces selected options")
            : (zh ? "多选 · 可同时选择选项和自定义回答" : "Multi-select · Options and custom answer can be combined")
          : (zh ? "单选 · 选择一项，或填写自定义回答" : "Single-select · Pick an option or enter a custom answer")}
      </p>
      <div className="dk-opts" role={question.multi || (question.toggleList && onChoose) ? "group" : "radiogroup"} aria-label={question.question}>
        {question.options.map((option, index) => {
          const toggle = question.toggleList === true && onChoose !== undefined;
          const on = toggle ? option.mark === "checked" : picked.includes(option.label);
          return (
            <button key={option.label} type="button" className={`dk-opt${on ? " sel" : ""}${toggle && option.mark === undefined ? " is-action" : ""}`}
              {...(toggle ? option.mark === undefined ? {} : { role: "checkbox", "aria-checked": on } : { role: question.multi ? "checkbox" : "radio", "aria-checked": on })}
              autoFocus={index === question.initial && toggle}
              disabled={choicesDisabled}
              onClick={() => { setCustomEditing(false); if (toggle) onChoose(option.label); else onPick(option.label); }}>
              <span className="dk-opt-row">
                <span className={toggle ? option.mark === undefined ? "o-action" : "o-check" : question.multi ? "o-check" : "o-radio"} aria-hidden="true" />
                <span className="o-label">{option.label}</span>
                {index === question.recommended ? <span className="chip purple xs">Recommended</span> : null}
              </span>
              {option.description ? <span className="dk-opt-desc">{option.description}</span> : null}
              {option.preview ? <span className="dk-opt-preview">{option.preview}</span> : null}
            </button>
          );
        })}
        <div className={`ask-custom-choice${customActive ? " is-active" : ""}`}>
          <AskImages
            heading={<button type="button" className="ask-custom-toggle" role={exclusive ? "radio" : "checkbox"} aria-label={zh ? "自定义回答选项" : "Custom answer option"} aria-checked={customActive} disabled={choicesDisabled} onClick={chooseCustom}><span className={exclusive ? "o-radio" : "o-check"} aria-hidden="true" /><span>{zh ? "自定义回答" : "Custom answer"}</span></button>}
            allowImages={imagesAllowed} onBusy={setCustomBusy} label={zh ? "回答 / Answer" : "Answer"} ariaLabel={zh ? "自定义回答" : "Custom answer"}
            text={answer.custom} images={answer.customInputImages ?? []} doc={answer.customDoc} editorRef={inputRef} disabled={disabled}
            placeholder={imagesAllowed ? (zh ? "填写其他答案，也可粘贴图片…" : "Type another answer, or paste an image…") : (zh ? "填写其他答案…" : "Type another answer…")}
            onChange={value => {
              setCustomEditing(true);
              if (onPatch) onPatch({ custom: value.text, customInputImages: value.images, customDoc: value.doc });
              else onCustom(value.text);
            }}
            onSubmit={() => { if (!customBusy && !noteBusy && askAnswered(answer)) onSubmit(); }}
          />
        </div>
      </div>
      {question.acceptImages !== undefined && onPatch ? (
        <AskImages
          multiline allowImages={imagesAllowed} heading={<span className="ask-note-title">{zh ? "补充说明" : "Additional note"} <span>{zh ? "可选" : "Optional"}</span></span>}
          hint={<div id={noteId} className="ask-note-target" data-tip={zh ? "补充说明附加在当前回答后，不会替代回答" : "Additional note is appended to your current answer without replacing it"}>
            {noteTargetCount ? <>
              <span>{zh ? "附加到" : "Attach to"}</span>
              {noteTargetCount > 1 ? <AppSelect className="select" aria-label={zh ? "备注对象 / Note on" : "Note on"} value={noteOption === undefined ? "custom" : `option:${picked.indexOf(noteOption)}`} disabled={choicesDisabled} data-tip={zh ? "选择这条补充说明的归属" : "Choose which answer this note applies to"} onChange={event => onPatch({ noteOption: event.target.value === "custom" ? undefined : picked[Number(event.target.value.slice(7))] })}>
                {picked.map((label, index) => <option key={label} value={`option:${index}`}>{label}</option>)}
                {hasCustom ? <option value="custom">{zh ? "自定义回答" : "Custom answer"}</option> : null}
              </AppSelect> : <strong data-tip={noteOption ?? (zh ? "自定义回答" : "Custom answer")}>{noteOption ?? (zh ? "自定义回答" : "Custom answer")}</strong>}
              <span>{zh ? "· 不替代回答" : "· Does not replace answer"}</span>
            </> : <span>{zh ? "先选择或填写回答" : "Select or enter an answer first"}</span>}
          </div>}
          onBusy={setNoteBusy} label={zh ? "备注 / Note" : "Note"} ariaLabel={zh ? "备注 / Note" : "Note"} describedBy={noteId}
          text={answer.note ?? ""} images={answer.noteImages ?? []} doc={answer.noteDoc} disabled={noteDisabled}
          placeholder={imagesAllowed ? (zh ? "补充细节，也可粘贴图片…" : "Add extra details, or paste an image…") : (zh ? "补充细节…" : "Add extra details…")}
          onChange={value => onPatch({ note: value.text, noteImages: value.images, noteDoc: value.doc })}
        />
      ) : null}
    </div>
  );
}

export function AskActions({
  disabled,
  canSubmit,
  onCancel,
  onSubmit,
}: {
  disabled?: boolean;
  canSubmit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return (
    <div className="dk-actions">
      <button type="button" className="btn lg outline" disabled={disabled} onClick={onCancel}>{zh ? "取消" : "Cancel"}</button>
      <button type="button" className="btn lg primary" disabled={disabled || !canSubmit} onClick={onSubmit}>{zh ? "提交" : "Submit"}</button>
    </div>
  );
}
