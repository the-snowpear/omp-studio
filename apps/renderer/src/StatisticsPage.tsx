import { FrustrationPane } from "./FrustrationPane";
import { AccountStatusPane } from "./models/AccountStatusPane";
import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { StatsFilter, StatsRow, StatsSnapshot } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "./preview/PreviewContext";
import { statsPreview } from "./preview/statsPreview";
import { useI18n } from "./i18n";
import { hostErrorMessage } from "./hostError";
import "./models/benchmark.css";

export function StatisticsPage({client}:{client:StudioClient}){
 const {preview}=usePreviewMode();const {resolvedLanguage}=useI18n();const zh=resolvedLanguage==="zh";
 const [filter,setFilter]=useState<StatsFilter>({range:"all"});const [draft,setDraft]=useState({model:"",provider:"",folder:""});const [tab,setTab]=useState("overview");const [data,setData]=useState<StatsSnapshot>();const [error,setError]=useState("");const [refresh,setRefresh]=useState(0);
 useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>;setError("");if(preview){setData(statsPreview(filter));return;}setData(undefined);let first=true;
  const read=async()=>{try{const result=await client.query("stats.read",{filter,...(first&&refresh>0?{refresh:true}:{})});first=false;if(active)setData(result);}catch(cause){if(active)setError(hostErrorMessage(cause,zh?"统计不可用":"Statistics unavailable"));}finally{if(active)timer=setTimeout(()=>void read(),2000);}};void read();return()=>{active=false;clearTimeout(timer);};
 },[client,filter,preview,refresh]);
 const tabs=[{id:"overview",label:zh?"概览":"Overview"},{id:"models",label:zh?"模型与提供商":"Models and providers"},{id:"costs",label:zh?"费用与额度":"Costs and quotas"},{id:"tools",label:zh?"工具与错误":"Tools and errors"},{id:"projects",label:zh?"项目与会话":"Projects and sessions"},{id:"frustration",label:"Frustration"}];
 const cost=(row:StatsRow)=>row.costEstimate===null?(zh?"未知":"Unknown"):"$"+row.costEstimate.toFixed(4)+(row.unpriced>0?(zh?"（部分已定价）":" (partially priced)"):"");
 const table=(rows:StatsRow[],label:string)=><table className="benchmark-table" aria-label={label}><thead><tr>{[label,zh?"请求 / 调用":"Requests / calls",zh?"错误":"Errors","Tokens",zh?"API 等价估算":"API-equivalent estimate",zh?"未定价":"Unpriced"].map(text=><th key={text}>{text}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.label}</td><td>{row.requests.toLocaleString()}</td><td>{row.errors?.toLocaleString()??"—"}</td><td>{Math.round(row.tokens).toLocaleString()}</td><td>{cost(row)}</td><td>{row.unpriced.toLocaleString()}</td></tr>)}</tbody></table>;
 return <div className="page-wide"><h2>{zh?"本机 OMP 统计":"Local OMP statistics"}{preview?<span className="chip gray xs">{zh?"演示":"Demo"}</span>:null}</h2>
  <p className="muted">{zh?"默认汇总全部本机历史；先显示缓存，再后台同步。金额为 API 等价估算，实际账单费用未提供。":"All local history by default. Cached results appear before background synchronization. Costs are API-equivalent estimates; actual billed costs are not provided."}</p>
  <form className="benchmark-toolbar" onSubmit={event=>{event.preventDefault();setFilter({range:filter.range??"all",...Object.fromEntries(Object.entries(draft).filter(([,v])=>v.trim()).map(([k,v])=>[k,v.trim()]))} as StatsFilter);}}>
   <label>{zh?"时间":"Time"}<select className="select" value={filter.range??"all"} onChange={event=>setFilter({...filter,range:event.target.value as NonNullable<StatsFilter["range"]>})}>{["all","1h","24h","7d","30d","90d"].map(value=><option key={value} value={value}>{value==="all"?(zh?"全部":"All"):value}</option>)}</select></label>
   {(["model","provider","folder"] as const).map(key=><label key={key}>{key==="model"?(zh?"模型":"Model"):key==="provider"?(zh?"提供商":"Provider"):(zh?"项目目录":"Project folder")}<input className="input" value={draft[key]} onChange={event=>setDraft({...draft,[key]:event.target.value})}/></label>)}<button className="btn small">{zh?"应用过滤":"Apply filters"}</button><button type="button" className="btn small outline" onClick={()=>setRefresh(n=>n+1)}>{zh?"同步":"Sync"}</button>
  </form>
  {error?<p role="alert">{error}</p>:null}{data?.reason?<p role="status">{data.reason}</p>:null}
  {data?<p className="small muted">{zh?"同步":"Sync"}: {data.sync.state} · {data.sync.current}/{data.sync.total} · {zh?"已处理":"Processed"} {data.sync.processed}{data.updatedAt?` · ${new Date(data.updatedAt).toLocaleString()}`:""}{data.cached?(zh?" · 缓存":" · Cached"):""}</p>:<p role="status">{zh?"读取统计…":"Loading statistics…"}</p>}
  <div role="tablist" aria-label={zh?"统计分类":"Statistics categories"}>{tabs.map(item=><button className="btn small outline" role="tab" aria-selected={tab===item.id} key={item.id} onClick={()=>setTab(item.id)}>{item.label}</button>)}</div>
  <section role="tabpanel">{data?.available?tab==="overview"?table([data.overall],zh?"总计":"Total"):tab==="models"?<>{table(data.models,zh?"模型":"Models")}{table(data.providers,zh?"提供商":"Providers")}</>:tab==="costs"?<><AccountStatusPane client={client}/>{table(data.models,zh?"费用":"Costs")}<p>{zh?"统计数据库不提供实时账户额度；请在模型配置页查看账户与额度。":"The statistics database does not provide live account quotas. See Accounts in model configuration."}</p></>:tab==="tools"?table(data.tools,zh?"工具":"Tools"):tab==="projects"?<>{table(data.projects,zh?"项目":"Projects")}{table(data.sessions??[],zh?"会话记录（最近 500 条）":"Session records (latest 500)")}</>:<FrustrationPane client={client} filter={filter} data={data.frustration} onUpdated={()=>setRefresh(n=>n+1)}/>:null}</section>
 </div>;
}
