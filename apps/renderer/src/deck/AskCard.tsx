import { AppSelect } from "../AppSelect";
import { MarkdownInline } from "../conversation/markdown";
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
  return (
    <PromptHead
      icon="message"
      title="Agent 提问"
      {...(onCollapse ? { end: <button type="button" className="btn small ghost" onClick={onCollapse} data-tip={PLATFORM === "darwin" ? "⌥H" : "Alt+H"}>收起 / Hide</button> } : {})}
      {...(demo === true ? { demo: true } : {})}
      {...(meta ? { meta } : {})}
      {...(queue ? { queue } : {})}
      {...(headers.length > 1 ? {
        chips: (
          <span className="dk-head-chips" role="tablist" aria-label="问题">
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
  question, answer, disabled, onPick, onCustom, onPatch, onSubmit, onBusy,
}: {
  onBusy?: (busy: boolean) => void;
  question: DeckAskQuestion;
  answer: DeckAskAnswer;
  disabled?: boolean;
  onPick: (label: string) => void;
  onCustom: (value: string) => void;
  onPatch?: (patch: Partial<DeckAskAnswer>) => void;
  onSubmit: () => void;
}) {
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
        {question.multi ? exclusive ? "多选 · 自定义回答会替代已选项" : "多选 · 可同时选择选项和自定义回答" : "单选 · 选择一项，或填写自定义回答"}
      </p>
      <div className="dk-opts" role={question.multi ? "group" : "radiogroup"} aria-label={question.question}>
        {question.options.map((option, index) => {
          const on = picked.includes(option.label);
          return (
            <button key={option.label} type="button" className={`dk-opt${on ? " sel" : ""}`} role={question.multi ? "checkbox" : "radio"} aria-checked={on} disabled={choicesDisabled} onClick={() => { setCustomEditing(false); onPick(option.label); }}>
              <span className="dk-opt-row">
                <span className={question.multi ? "o-check" : "o-radio"} aria-hidden="true" />
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
            heading={<button type="button" className="ask-custom-toggle" role={exclusive ? "radio" : "checkbox"} aria-label="自定义回答选项" aria-checked={customActive} disabled={choicesDisabled} onClick={chooseCustom}><span className={exclusive ? "o-radio" : "o-check"} aria-hidden="true" /><span>自定义回答</span></button>}
            allowImages={imagesAllowed} onBusy={setCustomBusy} label="回答 / Answer" ariaLabel="自定义回答"
            text={answer.custom} images={answer.customInputImages ?? []} doc={answer.customDoc} editorRef={inputRef} disabled={disabled}
            placeholder={imagesAllowed ? "填写其他答案，也可粘贴图片…" : "填写其他答案…"}
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
          multiline allowImages={imagesAllowed} heading={<span className="ask-note-title">补充说明 <span>可选</span></span>}
          hint={<div id={noteId} className="ask-note-target" data-tip="补充说明附加在当前回答后，不会替代回答">
            {noteTargetCount ? <>
              <span>附加到</span>
              {noteTargetCount > 1 ? <AppSelect className="select" aria-label="备注对象 / Note on" value={noteOption === undefined ? "custom" : `option:${picked.indexOf(noteOption)}`} disabled={choicesDisabled} data-tip="选择这条补充说明的归属" onChange={event => onPatch({ noteOption: event.target.value === "custom" ? undefined : picked[Number(event.target.value.slice(7))] })}>
                {picked.map((label, index) => <option key={label} value={`option:${index}`}>{label}</option>)}
                {hasCustom ? <option value="custom">自定义回答</option> : null}
              </AppSelect> : <strong data-tip={noteOption ?? "自定义回答"}>{noteOption ?? "自定义回答"}</strong>}
              <span>· 不替代回答</span>
            </> : <span>先选择或填写回答</span>}
          </div>}
          onBusy={setNoteBusy} label="备注 / Note" ariaLabel="备注 / Note" describedBy={noteId}
          text={answer.note ?? ""} images={answer.noteImages ?? []} doc={answer.noteDoc} disabled={noteDisabled}
          placeholder={imagesAllowed ? "补充细节，也可粘贴图片…" : "补充细节…"}
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
  return (
    <div className="dk-actions">
      <button type="button" className="btn lg outline" disabled={disabled} onClick={onCancel}>取消</button>
      <button type="button" className="btn lg primary" disabled={disabled || !canSubmit} onClick={onSubmit}>提交</button>
    </div>
  );
}
