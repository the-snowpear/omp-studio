import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { AgentBtwOperation, AgentBtwState } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { agentBtwPreview, PREVIEW_CHILD_BTW_TURNS } from "../preview/agentBtwPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { MarkdownText } from "../conversation/markdown";

export function AgentBtwPane({client,sessionId,agentId,available}:{client:StudioClient|undefined;sessionId:string|undefined;agentId:string;available:boolean}){
 const {preview}=usePreviewMode();const {resolvedLanguage}=useI18n();const zh=resolvedLanguage==="zh";
 const [state,setState]=useState<AgentBtwState>();const [draft,setDraft]=useState("");const [topic,setTopic]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 const demoHistory=useRef<Record<string,AgentBtwState["turns"]>>({"demo-child-topic":[...PREVIEW_CHILD_BTW_TURNS]});
 const epoch=useRef(0);const binding=useRef<string|undefined>(undefined);const stopped=useRef(false);const action=useRef(false);const topicRef=useRef(topic);topicRef.current=topic;const availableRef=useRef(available);availableRef.current=available;
 const execute=async(operation:AgentBtwOperation)=>{if(!client)throw Error("Host unavailable");const {kind,...input}=operation;const handle=await client.command(kind,input as never);return (await waitReceipt<{result:AgentBtwState}>(client,handle.requestId)).result;};
 useEffect(()=>{const generation=++epoch.current;binding.current=undefined;stopped.current=false;setState(preview?agentBtwPreview(agentId):undefined);setTopic("");setDraft("");setError("");setBusy(false);let timer:ReturnType<typeof setTimeout>;
  const read=async()=>{if(!preview&&client&&sessionId&&availableRef.current&&!stopped.current&&!action.current){try{const requestedTopic=topicRef.current;const result=await execute({kind:"agent.btw.read",sessionId,agentId,...(binding.current?{binding:binding.current}:{}),...(topicRef.current?{topicId:topicRef.current}:{})});if(generation===epoch.current){binding.current=result.binding;if(requestedTopic===topicRef.current)setState(result);}}catch(cause){if(generation===epoch.current){stopped.current=true;setError(hostErrorMessage(cause,zh?"子代理 BTW 不可用；请重新打开此目标":"Child BTW unavailable; reopen this target"));}}}if(generation===epoch.current)timer=setTimeout(()=>void read(),500);};if(!preview)void read();return()=>{epoch.current++;clearTimeout(timer);};
 },[client,sessionId,agentId,preview]);
 const send=async(cancel=false)=>{
  if(action.current||(!cancel&&!draft.trim()))return;
  if(preview){const now=Date.now();const answer=zh?"演示：本话题只使用所选子代理的上下文，不会发往 Host。":"Demo: this topic uses only the selected child context; no Host call.";const topicId=topic||"demo-topic-"+now;const turns=[...(demoHistory.current[topicId]??[]),{question:draft,answer,status:"complete",createdAt:now,updatedAt:now}];demoHistory.current[topicId]=turns;setState(current=>({...current!,snapshot:{ephemeralId:"demo-child-answer",topicId,question:draft,text:answer,status:"completed"},topics:[{topicId,question:turns[0]!.question,status:"complete",updatedAt:now,turnCount:turns.length},...current!.topics.filter(item=>item.topicId!==topicId)],turns}));setTopic(topicId);setDraft("");return;}
  if(!available||!sessionId||!binding.current||stopped.current)return;
  const generation=epoch.current;action.current=true;setBusy(true);
  try{const base={sessionId,agentId,binding:binding.current};const result=await execute(cancel?{...base,kind:"agent.btw.abort",ephemeralId:state!.snapshot!.ephemeralId}:{...base,kind:"agent.btw.ask",question:draft.trim(),...(topic?{topicId:topic}:{})});if(generation===epoch.current){setState(result);if(!cancel){setDraft("");setTopic(result.snapshot?.topicId??topic);}}}
  catch(cause){if(generation===epoch.current){stopped.current=true;setError(hostErrorMessage(cause,zh?"目标失效或回执不确定，请检查后重新打开":"Target invalid or outcome uncertain; inspect and reopen"));}}finally{action.current=false;if(generation===epoch.current)setBusy(false);}
 };
 const running=state?.snapshot?.status==="running";
 const live=state?.snapshot&&state.snapshot.topicId===topic?state.snapshot:null;
 return <section className="btw-panel" aria-label={zh?"子代理 BTW":"Child agent BTW"}>
  <p className="small muted">{agentId} · {preview?(zh?"演示":"Demo"):(state?.targetSessionId??"—")} · {zh?"独立话题，使用此子代理的上下文":"Independent topics using this child's context"}</p>
  {!preview&&!available?<p role="status">{zh?"当前 Runtime 或目标不支持子代理 BTW":"This Runtime or target does not support child BTW"}</p>:null}
  <select className="select" aria-label={zh?"BTW 话题":"BTW topic"} value={topic} disabled={busy||running} onChange={event=>{const next=event.target.value;setTopic(next);setState(current=>current?{...current,turns:preview?(demoHistory.current[next]??[]):[]}:current);}}><option value="">{zh?"新话题":"New topic"}</option>{state?.topics.map(item=><option key={item.topicId} value={item.topicId}>{item.question}</option>)}</select>
  <div className="btw-body">{(topic?state?.turns:[])?.filter((turn,index,turns)=>index!==turns.length-1||turn.answer!==live?.text).map((turn,index)=><div key={index}><p>{turn.question}</p><MarkdownText text={turn.answer}/></div>)}{live?<><p>{live.question}</p><MarkdownText text={live.text} {...(running?{streaming:true}:{})}/></>:null}</div>
  {error?<p role="alert">{error}</p>:null}{live?.error?<p role="alert">{live.error.message}</p>:null}
  <form onSubmit={event=>{event.preventDefault();void send();}}><textarea className="input" aria-label={zh?"向子代理提问":"Ask child agent"} maxLength={65536} value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(!running&&!busy)void send();}}}/>
   <button className="btn primary" disabled={busy||running||!draft.trim()||(!preview&&(!available||!state||!!error))}>{topic?(zh?"追问":"Follow up"):(zh?"提问":"Ask")}</button>
   {running?<button type="button" className="btn" disabled={busy||!available||!!error} onClick={()=>void send(true)}>{zh?"取消":"Cancel"}</button>:null}
  </form>
 </section>;
}
