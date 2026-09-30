import { randomUUID } from "node:crypto";
import { Settings } from "../../config/settings";
import { setCfgApprovalHost } from "../../internal-urls/cfg-protocol";
import type { AgentSession } from "../../session/agent-session";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { StudioInteractionGateway } from "./interaction-port";

/** One native approval host, owned by the main Studio session. No headless/subagent bypass. */
export class StudioCfgService {
 constructor(readonly session: AgentSession, readonly interaction: StudioInteractionGateway) { this.rebind(); }
 rebind(): void {
  const tools=this.session.studioToolSession;
  if(tools && (tools.taskDepth ?? 0)===0) tools.settingsApproval=true;
  setCfgApprovalHost({
   persistentSettings: Settings.instance,
   approve: async request => {
    const owner=this.session.sessionId;
    const commandId='cfg-change:'+randomUUID();
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;if(this.interaction.pending()?.request.commandId===commandId)this.interaction.cancel('Configuration approval expired','expired');},120000);
    try {
     const choice=await this.interaction.select({commandId,title:request.path+'\n'+request.previous+' → '+request.value+'\n'+(request.save?'Save to user configuration':'Current session only')+(request.shadowedBy?'\nStill overridden by '+request.shadowedBy:''),options:[
      {id:'once',label:'Approve once / 批准一次'},
      {id:'session',label:'Always for this session / 本会话允许'},
      {id:'deny',label:'Deny / 拒绝'},
     ]});
     if(this.session.sessionId!==owner)return 'deny';
     return choice==='once'||choice==='session'?choice:'deny';
    }catch{return timedOut?'timeout':'deny';}finally{clearTimeout(timer);}
   },
   applied: change => {
    if(change.settings!==this.session.settings || change.path!=='defaultThinkingLevel' || typeof change.value!=='string')return;
    const level=parseConfiguredThinkingLevel(change.value);if(level!==undefined)this.session.setThinkingLevel(level);
   },
  });
 }
 dispose(): void { const tools=this.session.studioToolSession;if(tools)tools.settingsApproval=false;setCfgApprovalHost(null); }
}
