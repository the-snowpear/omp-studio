import { MarkdownInline } from "../conversation/markdown";
import {useState,useEffect} from "react";
import {AskImages} from "./AskImages";
import { PromptHead, type DeckQueue } from "./PromptHead";
import { askAnswered } from "./askContent";
import type { AskHeader, DeckAskAnswer, DeckAskQuestion } from "./types";

/** 常驻标题行：换页时高亮胶囊与 1/N 就地更新，行本身不重建、不平移。 */
export function AskHead({
  demo,
  meta,
  queue,
  headers,
  onJump,
}: {
  demo?: boolean;
  meta?: string;
  queue?: DeckQueue;
  /** 本批次全部 ask 的 header 胶囊（含当前卡）；多张 ask 时才显示。 */
  headers: readonly AskHeader[];
  onJump: (index: number) => void;
}) {
  return (
    <PromptHead
      icon="message"
      title="Agent 提问"
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
  question,
  answer,
  disabled,
  onPick,
  onCustom,
  onPatch,
  onSubmit,
  onBusy,
}: {
  onBusy?: (busy: boolean) => void;
  question: DeckAskQuestion;
  answer: DeckAskAnswer;
  disabled?: boolean;
  onPick: (label: string) => void;
  onCustom: (value: string) => void;
  onPatch?: (patch:Partial<DeckAskAnswer>)=>void;
  onSubmit: () => void;
}) {
  const [customFiles,setCustomFiles]=useState<readonly File[]>();const [noteFiles,setNoteFiles]=useState<readonly File[]>();
  const [customBusy,setCustomBusy]=useState(false);const [noteBusy,setNoteBusy]=useState(false);
  useEffect(()=>{onBusy?.(customBusy||noteBusy);return()=>onBusy?.(false);},[customBusy,noteBusy,onBusy]);
  return (
    <div className="ask-body">
      <p className="dk-sub"><MarkdownInline text={question.question} k={`q-${question.id}`} /></p>
      <div className="dk-opts" role={question.multi ? "group" : "radiogroup"} aria-label={question.question}>
        {question.options.map((option, index) => {
          const on = answer.picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              className={`dk-opt${on ? " sel" : ""}`}
              role={question.multi ? "checkbox" : "radio"}
              aria-checked={on}
              disabled={disabled}
              onClick={() => onPick(option.label)}
            >
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
      </div>
      <div className="dk-custom" style={{display:"grid",gridTemplateColumns:"minmax(0, 1fr)",gap:8}}>
        <input
          className="input dk-input"
          value={answer.custom}
          placeholder="自定义回答…"
          aria-label="自定义回答"
          disabled={disabled}
          onChange={(event) => onCustom(event.target.value)}
          onPaste={event=>{if(question.acceptImages&&event.clipboardData.files.length){event.preventDefault();setCustomFiles([...event.clipboardData.files]);}}}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && !customBusy && !noteBusy && askAnswered(answer)) onSubmit();
          }}
        />
        {question.acceptImages&&onPatch?<AskImages onBusy={setCustomBusy} label="回答 / Answer" images={answer.customInputImages??[]} onChange={customInputImages=>onPatch({customInputImages})} files={customFiles} disabled={disabled}/>:null}
        {question.acceptImages!==undefined&&onPatch?<><textarea className="input" aria-label="备注 / Note" placeholder="备注 / Note" value={answer.note??""} disabled={disabled} onChange={event=>onPatch({note:event.target.value})} onPaste={event=>{if(question.acceptImages&&event.clipboardData.files.length){event.preventDefault();setNoteFiles([...event.clipboardData.files]);}}}/>{question.acceptImages?<AskImages onBusy={setNoteBusy} label="备注 / Note" images={answer.noteImages??[]} onChange={noteImages=>onPatch({noteImages})} files={noteFiles} disabled={disabled}/>:null}</>:null}
      </div>
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
