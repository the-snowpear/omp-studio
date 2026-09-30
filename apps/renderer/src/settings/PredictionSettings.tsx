import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { PredictionControlAction, PredictionControlState } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_PREDICTION } from "../preview/predictionPreview";

export function PredictionSettings({client,sessionId,available}:{client:StudioClient|undefined;sessionId:string|undefined;available:boolean}) {
 const {preview}=usePreviewMode();const {resolvedLanguage}=useI18n();const zh=resolvedLanguage==="zh";
 const [open,setOpen]=useState(false);const [state,setState]=useState<PredictionControlState>();const [review,setReview]=useState<PredictionControlAction>();const [busy,setBusy]=useState(false);const [error,setError]=useState("");const epoch=useRef(0);const lock=useRef(false);
 const enabled=preview||!!client&&!!sessionId&&available;
 const run=async(action:PredictionControlAction)=>{
  if(lock.current||!enabled)return;const generation=epoch.current;lock.current=true;setBusy(true);setError("");
  try{if(preview){setState(old=>{const value=structuredClone(old??PREVIEW_PREDICTION);if(action==="clear")value.corpusCount=0;if(action==="import")value.corpusCount+=120;if(action==="download"){value.modelReady=true;value.download.state="completed";value.download.loaded=value.download.total;}return value;});return;}
   const handle=await client!.command("prediction.control",{sessionId:sessionId!,action});const result=await waitReceipt<{result:PredictionControlState}>(client!,handle.requestId);if(epoch.current===generation)setState(result.result);
  }catch(cause){if(epoch.current===generation)setError(hostErrorMessage(cause,zh?"预测操作失败":"Prediction action failed"));}finally{lock.current=false;if(epoch.current===generation){setBusy(false);setReview(undefined);}}
 };
 useEffect(()=>{epoch.current++;setState(preview?structuredClone(PREVIEW_PREDICTION):undefined);setError("");if(open)void run("status");return()=>{epoch.current++;};},[client,sessionId,available,preview,open]);
 useEffect(()=>{if(!open||preview||state?.download.state!=="running")return;const timer=setTimeout(()=>void run("status"),1500);return()=>clearTimeout(timer);},[state,open,preview]);
 const text=review==="clear"?(zh?"删除 Studio 学习语料及预测状态？":"Delete Studio's learned corpus and prediction state?"):review==="import"?(zh?"将本机 Claude Code 与 Codex 的提示历史导入 Studio 预测语料？这些文本将用于本地学习。":"Import local Claude Code and Codex prompt histories into Studio's prediction corpus for local learning?"):(zh?"从 Hugging Face 下载 SmolLM2-135M（约 147 MB）？下载经过固定版本与校验和验证；完成后可在预测引擎中选择 SmolLM。":"Download SmolLM2-135M from Hugging Face (about 147 MB)? The pinned files are checksum verified. Select SmolLM as the prediction engine after download.");
 return <details className="runtime-credentials" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{zh?"输入预测语料与模型":"Prediction corpus and model"}{preview?zh?" · 演示":" · Demo":""}</summary>{open?<>
  <p className="small muted">{zh?"本地 N-gram 默认启用；只学习已发送文本。草稿仅用于即时查询。可在上方预测引擎中选择 off 关闭。":"Local N-gram is enabled by default and learns sent text only. Drafts are queried transiently. Choose off in the engine setting to disable it."}</p>
  {!enabled?<p role="status">{zh?"当前 Runtime 未提供预测管理能力":"Prediction management is unavailable in this Runtime"}</p>:null}
  {state?<p>{zh?"语料条数":"Corpus entries"}: {state.corpusCount} · SmolLM2: {state.modelReady?(zh?"已下载":"Downloaded"):(zh?"未下载":"Not downloaded")}</p>:null}
  {(["clear","import","download"] as const).map(action=><button key={action} className="btn small outline" disabled={!enabled||busy||state?.download.state==="running"} onClick={()=>setReview(action)}>{action==="clear"?(zh?"清理语料":"Clear corpus"):action==="import"?(zh?"导入外部历史":"Import external history"):(zh?"下载 SmolLM2":"Download SmolLM2")}</button>)}
  {state?.download.state==="running"?<><progress max={state.download.total} value={state.download.loaded}/><button className="btn small" disabled={busy} onClick={()=>void run("cancel")}>{zh?"取消下载":"Cancel download"}</button></>:null}
  {error||state?.download.error?<p role="alert">{error||state?.download.error}</p>:null}
  {review?<div role="alertdialog" aria-modal="true" aria-label={zh?"确认预测操作":"Confirm prediction action"}><p>{text}</p><button className="btn primary" disabled={busy} onClick={()=>void run(review)}>{zh?"确认":"Confirm"}</button><button className="btn" disabled={busy} onClick={()=>setReview(undefined)}>{zh?"取消":"Cancel"}</button></div>:null}
 </>:null}</details>;
}
