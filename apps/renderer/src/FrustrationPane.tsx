import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { FrustrationData, FrustrationInput, FrustrationResult, StatsFilter } from "@omp-studio/studio-protocol";
import { useI18n } from "./i18n";
import { usePreviewMode } from "./preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "./hostError";

export function FrustrationPane({client,filter,data,onUpdated}:{client:StudioClient;filter:StatsFilter;data:FrustrationData|undefined;onUpdated:()=>void}){
 const {preview}=usePreviewMode();const {resolvedLanguage}=useI18n();const zh=resolvedLanguage==="zh";
 const [quote,setQuote]=useState<FrustrationResult["quote"]>();const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [localJob,setLocalJob]=useState<FrustrationResult["job"]>();const epoch=useRef(0);const lock=useRef(false);
 useEffect(()=>{epoch.current++;setQuote(undefined);setError("");setLocalJob(undefined);return()=>{epoch.current++;};},[filter,preview]);
 const job=localJob??data?.job;
 useEffect(()=>setLocalJob(undefined),[data?.job.state,data?.job.done]);
 const act=async(action:FrustrationInput["action"])=>{
  if(lock.current)return;const generation=epoch.current;lock.current=true;setBusy(true);setError("");
  try{let result:FrustrationResult;
   if(preview){result=action==="estimate"||action==="retry"?{available:true,quote:{id:"demo",filter,messages:12,cost:0.012,judge:"demo/judge",expiresAt:Date.now()+300000}}:{available:true,job:{state:action==="cancel"?"cancelled":"done",total:12,done:12,failed:0,cost:0.01,judge:"demo/judge",filter}};}
   else{const handle=await client.command("stats.frustration",{action,filter,...(action==="start"&&quote?{quoteId:quote.id}:{})});result=await waitReceipt<FrustrationResult>(client,handle.requestId);}
   if(epoch.current!==generation)return;if(!result.available){setError(result.reason??(zh?"Judge 不可用":"Judge unavailable"));setQuote(undefined);return;}if(result.quote)setQuote(result.quote);if(result.job){setLocalJob(result.job);setQuote(undefined);if(!preview)onUpdated();}
  }catch(cause){if(epoch.current===generation)setError(hostErrorMessage(cause,zh?"分析操作失败":"Analysis action failed"));}finally{lock.current=false;setBusy(false);}
 };
 return <div><p className="muted">{zh?"未分析的消息使用原生规则统计；Judge 结果写入本机数据库并保留。刷新只读取结果。":"Unjudged messages use native rule-based counts. Judge results are retained in the local database. Refresh only reads results."}</p>
  {data?<table className="benchmark-table"><thead><tr>{[zh?"模型":"Model",zh?"消息":"Messages",zh?"已分析":"Judged",zh?"烦躁":"Annoyed",zh?"针对助手":"At assistant",zh?"愤怒":"Angry"].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{[{...data.overall,id:"all",label:zh?"全部":"All"},...data.models].map(row=><tr key={row.id}><td>{row.label}</td><td>{row.messages}</td><td>{row.judged}</td><td>{row.annoyed}</td><td>{row.atAssistant}</td><td>{row.angry}</td></tr>)}</tbody></table>:<p>{zh?"暂无统计":"No statistics available"}</p>}
  {job?<p role="status">{job.state} · {job.done}/{job.total} · {zh?"失败":"Failed"}: {job.failed} · {job.judge??"—"} · {zh?"API 等价估算":"API-equivalent estimate"}: {job.cost===null?(zh?"未知":"Unknown"):"$"+job.cost.toFixed(4)}{job.filter?` · ${JSON.stringify(job.filter)}`:""}</p>:null}
  <button className="btn outline" disabled={busy||job?.state==="running"} onClick={()=>void act("estimate")}>{zh?"估算分析范围与费用":"Estimate analysis and cost"}</button>
  <button className="btn outline" disabled={busy||job?.state==="running"||!job?.failed} onClick={()=>void act("retry")}>{zh?"估算失败项重试":"Estimate retry of failed items"}</button>
  {job?.state==="running"?<button className="btn" disabled={busy} onClick={()=>void act("cancel")}>{zh?"取消分析":"Cancel analysis"}</button>:null}
  {quote?<section role="alertdialog" aria-modal="true" aria-label={zh?"确认 Frustration 分析":"Confirm Frustration analysis"}><p>{zh?"范围":"Scope"}: {JSON.stringify(quote.filter)}</p><p>{quote.messages} {zh?"条待分析唯一文本":"unique pending texts"} · {quote.judge} · {quote.cost===null?(zh?"价格未知":"Price unknown"):"$"+quote.cost.toFixed(4)}</p><p>{zh?"确认后会将范围内文本发送给配置的 Judge，可能产生模型费用。估算不包含可能的重试差异。":"Confirmation sends the scoped text to the configured Judge and may incur model charges. Retries can change the estimated cost."}</p><button className="btn primary" disabled={busy||Date.now()>quote.expiresAt} onClick={()=>void act("start")}>{zh?"确认并分析":"Confirm and analyze"}</button><button className="btn" disabled={busy} onClick={()=>setQuote(undefined)}>{zh?"返回":"Back"}</button></section>:null}
  {error?<p role="alert">{error}</p>:null}
 </div>;
}
