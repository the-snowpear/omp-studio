import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyStats, validateStatsFilter, validateStatsSnapshot, validateFrustrationInput, validateFrustrationResult, type FrustrationInput, type FrustrationResult, type StatsFilter, type StatsSnapshot } from "@omp-studio/studio-protocol";

/** Unknown CLI worker selectors may be interpreted as prompts by older binaries. */
export function supportsNativeStatsWorker(version:string):boolean {
 const match=/^18\.4\.4-studio\.(\d+)$/.exec(version);
 return match!==null&&Number.isSafeInteger(Number(match[1]))&&Number(match[1])>=26;
}

/** One native worker per Host, surviving renderer reloads. Stdio is a private typed channel. */
export class NativeStatsWorker {
 #child:ChildProcessWithoutNullStreams|undefined;
 #starting:Promise<void>|undefined;
 #disposed=false;
 #seq=0;
 #pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 #cache=new Map<string,StatsSnapshot>();
 #inflight=new Set<string>();
 #lastSync=0;
 #retryAt=0;
 constructor(readonly options:{executable:()=>Promise<string|undefined>;cacheFile:string;spawn?:typeof spawn}){}
 async frustration(input:FrustrationInput):Promise<FrustrationResult>{validateFrustrationInput(input);await this.#ensure();const result=await this.#request("frustration",{input});validateFrustrationResult(result);return result;}
 async read(input:{filter:StatsFilter;refresh?:boolean}):Promise<StatsSnapshot>{
  validateStatsFilter(input.filter);const filter={range:input.filter.range??"all",...input.filter};const key=JSON.stringify(filter);
  if(!this.#cache.has(key))try{if((await stat(this.options.cacheFile)).size<=2097152){const cached=JSON.parse(await readFile(this.options.cacheFile,"utf8"));validateStatsSnapshot(cached);if(JSON.stringify(cached.filter)===key)this.#cache.set(key,{...cached,cached:true});}}catch{/* Missing or invalid cache is an honest empty initial state. */}
  const cached=this.#cache.get(key);this.#refresh(key,filter,input.refresh===true);
  return structuredClone(cached?{...cached,cached:true}:emptyStats(filter,"Loading local statistics"));
 }
 #refresh(key:string,filter:StatsFilter,force:boolean):void{
  if(this.#disposed||this.#inflight.has(key)||!force&&Date.now()<this.#retryAt)return;this.#inflight.add(key);
  void(async()=>{try{
   await this.#ensure();const value=await this.#request("read",{filter});validateStatsSnapshot(value);this.#cache.set(key,value);if(this.#cache.size>20)this.#cache.delete(this.#cache.keys().next().value!);
   await mkdir(dirname(this.options.cacheFile),{recursive:true});const temporary=this.options.cacheFile+"."+randomUUID()+".tmp";await writeFile(temporary,JSON.stringify(value));await rename(temporary,this.options.cacheFile);
   if(force||Date.now()-this.#lastSync>60000){this.#lastSync=Date.now();await this.#request("sync",{});}
  }catch{this.#retryAt=Date.now()+30000;const cached=this.#cache.get(key);this.#cache.set(key,cached?{...cached,cached:true,reason:"Statistics refresh failed; showing last cached data"}:emptyStats(filter,"This Runtime does not provide a compatible statistics worker"));}finally{this.#inflight.delete(key);}})();
 }
 async #ensure():Promise<void>{
  if(this.#disposed)throw Error("Statistics worker closed");if(this.#starting)return this.#starting;if(this.#child)return;
  this.#starting=(async()=>{
   const executable=await this.options.executable();if(!executable)throw Error("Managed Runtime unavailable");if(this.#disposed)throw Error("Statistics worker closed");
   const child=(this.options.spawn??spawn)(executable,["__omp_worker_studio_stats"],{windowsHide:true,stdio:["pipe","pipe","pipe"]}) as ChildProcessWithoutNullStreams;this.#child=child;let buffer="";
   const fail=()=>{if(this.#child!==child)return;this.#child=undefined;for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(Error("Statistics worker disconnected"));}this.#pending.clear();};
   child.once("error",fail);child.once("exit",fail);child.stderr.resume();child.stdout.setEncoding("utf8");child.stdout.on("data",(chunk:string)=>{buffer+=chunk;if(buffer.length>2097152){child.kill();fail();return;}for(let at=buffer.indexOf("\n");at>=0;at=buffer.indexOf("\n")){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const response=JSON.parse(line);const pending=this.#pending.get(response.id);if(!pending)continue;this.#pending.delete(response.id);clearTimeout(pending.timer);if(response.ok===true)pending.resolve(response.result);else pending.reject(Error("Statistics request failed"));}catch{child.kill();fail();}}});
   const hello=await this.#request("hello",{}) as {protocol?:number;kind?:string};if(hello.protocol!==1||hello.kind!=="studio-stats"){child.kill();fail();throw Error("Incompatible statistics worker");}
  })().finally(()=>{this.#starting=undefined;});return this.#starting;
 }
 #request(op:string,input:object):Promise<unknown>{
  const child=this.#child;if(!child)throw Error("Statistics worker unavailable");const id=++this.#seq;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.#pending.delete(id);reject(Error("Statistics request timed out"));child.kill();},30000);this.#pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,op,...input})+"\n",error=>{if(error){clearTimeout(timer);this.#pending.delete(id);reject(error);}});});
 }
 async dispose():Promise<void>{this.#disposed=true;const child=this.#child;this.#child=undefined;for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(Error("Statistics worker closed"));}this.#pending.clear();if(!child)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},3000);child.once("exit",()=>{clearTimeout(timer);resolve();});child.stdin.end();});}
}
