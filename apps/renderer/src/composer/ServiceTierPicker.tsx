import { useEffect, useRef, useState } from "react";
import type { StudioClient, SessionId } from "@omp-studio/client-contract";
import type { SessionTier, SessionTierState } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_SERVICE_TIER } from "../preview/sessionGuiPreview";

export function ServiceTierPicker({ client, sessionId, available, modelKey }: { client: StudioClient; sessionId: string | undefined; available: boolean; modelKey: string }) {
 const {preview}=usePreviewMode();const {resolvedLanguage}=useI18n();const zh=resolvedLanguage==="zh";
 const [state,setState]=useState<SessionTierState>();const [open,setOpen]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const epoch=useRef(0);
 useEffect(()=>{const generation=++epoch.current;setState(preview?PREVIEW_SERVICE_TIER:undefined);setError("");setBusy(false);
  if(!preview&&available&&sessionId){setBusy(true);void (async()=>{try{const handle=await client.command("session.tier.get",{sessionId});const value=await waitReceipt<{result:SessionTierState}>(client,handle.requestId);if(epoch.current===generation)setState(value.result);}catch(cause){if(epoch.current===generation)setError(hostErrorMessage(cause,zh?"档位不可用":"Service tiers unavailable"));}finally{if(epoch.current===generation)setBusy(false);}})();}
  return ()=>{epoch.current++;};
 },[client,sessionId,modelKey,available,preview]);
 const labels={standard:zh?"标准":"Standard",slow:"Slow",priority:"Priority",ultrafast:"Ultrafast"};
 const change=async(tier:SessionTier)=>{if(!state||busy)return;if(preview){setState({...state,configured:tier,effective:tier});return;}if(!sessionId||!available)return;const generation=epoch.current;setBusy(true);setError("");try{const handle=await client.command("session.tier.set",{sessionId:sessionId as SessionId,selector:state.selector,tier});const value=await waitReceipt<{result:SessionTierState}>(client,handle.requestId);if(epoch.current===generation)setState(value.result);}catch(cause){if(epoch.current===generation)setError(hostErrorMessage(cause,zh?"档位切换失败":"Could not change service tier"));}finally{if(epoch.current===generation)setBusy(false);}};
 return <div className="composer-tier" style={{position:"relative"}}>
  <button className="btn small outline" aria-expanded={open} aria-label={zh?"服务档位":"Service tier"} onClick={()=>setOpen(!open)}>{state?labels[state.effective]:zh?"档位":"Tier"}</button>
  {open?<div className="rms-pop" style={{position:"absolute",bottom:"100%",right:0,minWidth:250,padding:12}}>
   <p className="small muted">{preview?(zh?"演示":"Demo"):zh?"仅当前会话":"Current session only"}</p>
   {!preview&&!available?<p role="status">{zh?"当前 Runtime 不支持服务档位面板":"This Runtime does not support service tiers"}</p>:null}
   {state?<><p className="small">{zh?"配置":"Configured"}: {state.configured} · {zh?"生效":"Effective"}: {labels[state.effective]}</p>{state.choices.map(choice=><button key={choice.id} className="btn small outline" disabled={busy||!choice.available} title={choice.reason} aria-pressed={state.effective===choice.id} onClick={()=>void change(choice.id)}>{labels[choice.id]}</button>)}{state.usageStatus?<p role="status">{state.usageStatus}</p>:null}</>:null}
   {error?<p role="alert">{error}</p>:null}
  </div>:null}
 </div>;
}
