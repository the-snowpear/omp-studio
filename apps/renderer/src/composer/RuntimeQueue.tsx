import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { QueueTakeback, SessionQueueItem, SessionQueueSnapshot } from "@omp-studio/studio-protocol";
import { waitReceipt, hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";
import { artifactUrl } from "../media/ArtifactLibraryPane";
import { isImageMimeType, type ComposerSnapshot, type PromptImage } from "./types";
import { displayDocFromSerializedText, snapshotFromDoc, snapshotFromTextAndImages } from "./serialize";

export async function queueTakebackSnapshot(value:QueueTakeback):Promise<ComposerSnapshot> {
 const images:PromptImage[]=[];
 for(const asset of value.images){
  if(!isImageMimeType(asset.mimeType))throw Error("Unsupported recovered image type");
  const response=await fetch(artifactUrl(asset.artifactId));if(!response.ok)throw Error("Recovered image unavailable");
  const blob=await response.blob();if(blob.size!==asset.bytes)throw Error("Recovered image size changed");
  const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error("Image read failed"));reader.onload=()=>resolve(String(reader.result).split(",",2)[1]!);reader.readAsDataURL(blob);});
  images.push({type:"image",mimeType:asset.mimeType,data});
 }
 const restored=snapshotFromTextAndImages(value.text??"",images);
 return snapshotFromDoc({nodes:restored.doc.nodes.flatMap(node=>node.type==="text"?displayDocFromSerializedText(node.value).nodes:[node])});
}

/** Authoritative Runtime queue. No send retry and no Renderer-owned flush loop. */
export function RuntimeQueue({client,sessionId,available,hasDraft,onRecover}:{client:StudioClient;sessionId:string|undefined;available:boolean;hasDraft:()=>boolean;onRecover:(snapshot:ComposerSnapshot,sessionId:string)=>void}){
 const {resolvedLanguage}=useI18n();const zh=resolvedLanguage==="zh";
 const [offset,setOffset]=useState(0);
 const [snapshot,setSnapshot]=useState<SessionQueueSnapshot>();const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [review,setReview]=useState<SessionQueueItem>();const [recovered,setRecovered]=useState<{value:QueueTakeback;sessionId:string}>();const epoch=useRef(0);const locked=useRef(false);const delivered=useRef(new Set<string>());
 useEffect(()=>{const generation=++epoch.current;setSnapshot(undefined);setReview(undefined);setError("");let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{if(!available||!sessionId)return;try{const handle=await client.command("session.queue.list",{sessionId,...(offset?{offset}:{})});const result=await waitReceipt<{result:SessionQueueSnapshot}>(client,handle.requestId,10000);if(epoch.current===generation){setSnapshot(result.result);if(offset>=result.result.total&&offset>0)setOffset(Math.max(0,Math.floor(Math.max(0,result.result.total-1)/100)*100));setError("");}}catch(cause){if(epoch.current===generation)setError(hostErrorMessage(cause,zh?"队列状态不确定；不会自动重发":"Queue state uncertain; messages will not be resent"));}finally{if(epoch.current===generation)timer=setTimeout(()=>void poll(),1500);}};
  void poll();return()=>{epoch.current++;clearTimeout(timer);};
 },[client,sessionId,available,offset]);
 useEffect(()=>setOffset(0),[sessionId]);
 const restore=async(value:QueueTakeback,owner:string,generation:number)=>{
  const key=owner+":"+value.recoveryId;
  if(!value.recoveryId||!delivered.current.has(key)){
   const draft=await queueTakebackSnapshot(value);
   if(epoch.current!==generation)return;
   onRecover(draft,owner);
   if(value.recoveryId)delivered.current.add(key);
  }
  if(value.recoveryId){
   const handle=await client.command("session.queue.ack",{sessionId:owner,id:value.recoveryId});
   await waitReceipt(client,handle.requestId);
  }
  setRecovered(undefined);
 };
 const act=async(item:SessionQueueItem,takeback:boolean,steer=false)=>{if(!sessionId||locked.current)return;const owner=sessionId;const generation=epoch.current;locked.current=true;setBusy(true);setError("");try{
  if(takeback){const handle=await client.command("session.queue.takeback",{sessionId:owner,id:item.id});const {result}=await waitReceipt<{result:QueueTakeback}>(client,handle.requestId);if(!result.removed)throw Error(zh?"消息已被消费，无法取回":"Message already consumed; cannot take back");setRecovered({value:result,sessionId:owner});if(epoch.current===generation)await restore(result,owner,generation);}
  else{const handle=await client.command(steer?"session.queue.steer":"session.queue.remove",{sessionId:owner,id:item.id});const {result}=await waitReceipt<{result:{removed:boolean}}>(client,handle.requestId);if(!result.removed)throw Error(zh?"消息已被消费，无法取消":"Message already consumed; cannot cancel");}
  if(epoch.current===generation)setSnapshot(old=>old?steer?{...old,items:old.items.map(row=>row.id===item.id?{...row,queue:"steering"}:row)}:{...old,items:old.items.filter(row=>row.id!==item.id),total:Math.max(0,old.total-1)}:old);
 }catch(cause){setError(hostErrorMessage(cause,zh?"队列操作失败":"Queue operation failed"));}finally{locked.current=false;setBusy(false);setReview(undefined);}};
 return <>
  {snapshot&&snapshot.total>100?<div><button className="btn small" disabled={busy||offset===0} onClick={()=>setOffset(n=>Math.max(0,n-100))}>{zh?"上一页":"Previous"}</button><span>{offset+1}–{Math.min(offset+100,snapshot.total)} / {snapshot.total}</span><button className="btn small" disabled={busy||offset+100>=snapshot.total} onClick={()=>setOffset(n=>n+100)}>{zh?"下一页":"Next"}</button></div>:null}
  {snapshot?.items.length?<div className="queue-strip"><div className="qs-head-row"><span className="qs-title">{zh?"Runtime 排队":"Runtime queue"} ×{snapshot.total}</span><span className="qs-note">follow-up: {snapshot.followUpMode} · steering: {snapshot.steeringMode}</span></div><div className="qs-list">{snapshot.items.map(item=><div className="qs-item" key={item.id}><span className="qs-text">{item.text}{item.imageCount?` · ${item.imageCount} ${zh?"张图片":"images"}`:""}</span><span className="qs-status">{item.queue} · {item.state==="recovering"?(zh?"已取回，待恢复草稿":"Taken back; restore draft"):item.state==="pending"?(zh?"等待消费":"Pending"):(zh?"已接收":"Delivering")}</span><button className="btn small" disabled={busy||item.state==="delivering"} onClick={()=>{if(hasDraft()&&!delivered.current.has(sessionId+":"+item.id))setReview(item);else void act(item,true);}}>{zh?"取回编辑":"Take back"}</button><button className="btn small" disabled={busy||item.state!=="pending"||item.queue==="steering"} onClick={()=>void act(item,false,true)}>{zh?"插入纠偏":"Steer"}</button><button className="btn small" disabled={busy||item.state==="delivering"} onClick={()=>void act(item,false)}>{zh?"取消":"Cancel"}</button></div>)}</div></div>:null}
  {error?<p className="small" role="alert">{error}</p>:null}
  {recovered?<button className="btn small" disabled={busy||recovered.sessionId!==sessionId} onClick={()=>{setBusy(true);void restore(recovered.value,recovered.sessionId,epoch.current).catch(cause=>setError(String(cause))).finally(()=>setBusy(false));}}>{zh?"恢复草稿 / 确认已恢复（不会发送）":"Restore draft / acknowledge recovery (does not send)"}</button>:null}
  {review?<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={zh?"合并草稿":"Merge draft"}><p>{zh?"Composer 已有草稿。确认从 Runtime 移除这条消息后，合并到当前草稿？":"Composer already has a draft. Remove this queued message and merge it into the current draft?"}</p><button className="btn" disabled={busy} onClick={()=>setReview(undefined)}>{zh?"取消":"Cancel"}</button><button className="btn primary" disabled={busy} onClick={()=>void act(review,true)}>{zh?"取回并合并":"Take back and merge"}</button></section></div>:null}
 </>;
}
