/** Real Electron acceptance with isolated profiles and no model requests. */
import {createRequire} from 'node:module';
import {defaultRuntimeKeysDirectory} from './runtime-signing-keys.mjs';
import {resolveTargetPlatform} from './target-platform.mjs';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const { _electron }=require(process.env.PLAYWRIGHT_MODULE??'playwright');
// macOS sun_path is 104 bytes; the native prediction broker appends its socket name.
const temp=await mkdtemp(join(process.platform==='darwin'?'/tmp':tmpdir(),process.platform==='darwin'?'osg-':'omp-full-gui-'));
const output=process.env.OMP_E2E_OUTPUT_DIR??join(root,'outputs','full-gui-e2e');
const report={status:'running',modelCalls:0,checks:[],profile:temp};
let app,page;
const query=async(name,input={})=>{const r=await page.evaluate(({name,input})=>window.ompStudio.query({queryName:name,input}),{name,input});if(!r.ok)throw Error(JSON.stringify(r.error));return r.result;};
async function until(read,accept,label){const end=Date.now()+90000;let last;while(Date.now()<end){try{const value=await read();if(accept(value))return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw Error(label+': '+last);}
const command=async(name,input={})=>page.evaluate(({name,input})=>{
 const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{off();reject(Error('Receipt timeout: '+name));},45000);
  const off=window.ompStudio.subscribe({scope:'command',requestId},event=>{
   if(event.kind!=='command.receipt'||!['completed','failed','rejected','outcome_unknown'].includes(event.receipt.status))return;
   clearTimeout(timer);off();if(event.receipt.status==='completed')resolve(event.receipt.result);else reject(Error(JSON.stringify(event.receipt)));
  });
  window.ompStudio.command({commandName:name,input,requestId,idempotencyKey:requestId}).catch(error=>{clearTimeout(timer);off();reject(error);});
 });
},{name,input});
async function capture(name){await page.screenshot({path:join(output,name+'.png')});}
try{
 await Promise.all(['workspace','roaming','user-data','local','isolated-home'].map(p=>mkdir(join(temp,p),{recursive:true})));
 await mkdir(output,{recursive:true});
 const desktop=join(root,'apps/desktop');
 const version=JSON.parse(await readFile(join(root,'omp-patch/patches/series.json'),'utf8')).patchsetVersion;
 const runtime='18.4.4-'+version;
 const keys=defaultRuntimeKeysDirectory();
 const platform=resolveTargetPlatform();
 const isolatedHome=process.platform==='darwin'?join(temp,'isolated-home'):homedir();
 report.platform=platform;
 await writeFile(join(temp,'bootstrap.cjs'),[
  "const {app,dialog}=require('electron');",
  'app.getAppPath=()=>'+JSON.stringify(desktop)+';',
  "app.setPath('appData',"+JSON.stringify(join(temp,'roaming'))+');',
  "app.setPath('userData',"+JSON.stringify(join(temp,'user-data'))+');',
  'dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(join(temp,'workspace'))+']});',
  'import('+JSON.stringify(pathToFileURL(join(desktop,'dist/src/main.js')).href)+');',
 ].join('\n'));
 await writeFile(join(temp,'package.json'),JSON.stringify({name:'omp-gui-acceptance',version:'0.1.7',main:'bootstrap.cjs'}));
 const env={...process.env,...(process.platform==='darwin'?{HOME:isolatedHome}:{}),APPDATA:join(temp,'roaming'),LOCALAPPDATA:join(temp,'local'),PI_CONFIG_DIR:relative(isolatedHome,join(temp,'native-config')),XDG_CONFIG_HOME:join(temp,'xdg-config'),XDG_DATA_HOME:join(temp,'xdg-data'),XDG_CACHE_HOME:join(temp,'xdg-cache'),OMP_ARTIFACT_DIR:join(root,'packages/runtime-installer/dist/artifacts',platform,runtime),OMP_RUNTIME_TRUSTED_PUBLIC_KEY:join(keys,'trusted-public.pem'),OMP_RUNTIME_SIGNING_KEY_ID:(await readFile(join(keys,'key-id.txt'),'utf8')).trim(),DO_NOT_TRACK:'1'};
 for(const key of ['ELECTRON_RUN_AS_NODE','OMP_RUNTIME_SIGNING_PRIVATE_KEY','OMP_RENDERER_DEV_URL','PI_CODING_AGENT_DIR'])delete env[key];
 const packaged=process.env.OMP_E2E_PACKAGED_EXE;
 if(packaged)delete env.OMP_ARTIFACT_DIR;
 app=await _electron.launch({executablePath:packaged??require('electron'),args:packaged?['--user-data-dir='+join(temp,'user-data')]:[temp],cwd:join(temp,'workspace'),env,timeout:60000});
 if(packaged)await app.evaluate(({dialog},workspace)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});},join(temp,'workspace'));
 page=await app.firstWindow();page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>!!window.ompStudio);
 await page.evaluate(()=>{localStorage.setItem('omp.appSettings',JSON.stringify({language:'zh'}));localStorage.setItem('omp.previewMode','0');localStorage.setItem('omp.startupNotice.dismissed','incomplete-v1');localStorage.setItem('omp.lastRoute','home');});
 await page.reload();
 await page.getByRole('button',{name:/打开本地文件夹|Open local folder/i}).first().click();
 await until(()=>query('projects.list'),r=>r.workspaces.some(w=>w.active),'workspace');
 await command('session.create');
 const environment=await until(()=>query('environment.get'),r=>r.runtime.status==='connected','Runtime');
 if(environment.runtime.runtimeVersion!==runtime||environment.runtime.classification!=='managed')throw Error('Wrong Runtime');
 report.runtime=environment.runtime.runtimeVersion;
 if(packaged){
  const terminal=await page.evaluate(()=>window.ompStudioTerminal.create({cols:80,rows:24}));
  await page.evaluate(id=>window.ompStudioTerminal.dispose(id),terminal.id);
  report.checks.push('packaged application and native PTY creation/disposal');
 }
 const session=await query('session.state');
 const invoke=(name,input={})=>command(name,{sessionId:session.sessionId,...input});
 const caps=await query('capabilities.get');
 for(const id of ['ida.status','resource.read','session.queue.list','session.queue.ack','session.tier.get','session.skills.list','agent.btw.read'])if(!caps.capabilities.some(c=>c.id===id&&c.grade!=='unavailable'))throw Error('Missing '+id);
 report.checks.push('signed managed Runtime handshake and capability negotiation');
 for(const name of ['ida.status','session.queue.list','session.tier.get','session.skills.list']){const value=await invoke(name);if(name==='ida.status')report.ida=value;report.checks.push(name);}
 await invoke('resource.read',{uri:'omp://'});
 const prediction=await query('prediction.query',{sessionId:session.sessionId,version:1,before:'',prefix:'unsent-verification'});
 if(prediction.version!==1)throw Error('Prediction version mismatch');
 await query('stats.read',{filter:{range:'all'}});
 report.checks.push('resources, ephemeral prediction and isolated stats worker');
 const editor=page.locator('.composer-region [contenteditable="true"]').first();await editor.fill('unsent draft ');
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4});
 await cdp.send('Input.insertText',{text:'中文输入'});
 if(!(await editor.innerText()).includes('中文输入'))throw Error('Composition lost');
 await editor.press('Escape');if((await query('session.state')).isStreaming)throw Error('Draft submitted');
 report.checks.push('Chromium IME composition and Escape; unsent draft did not submit');await capture('real-composer');
 for(const preview of [false,true])for(const route of ['statistics','capabilities','settings','model-config','agent-hub']){
  await page.evaluate(({preview,route})=>{localStorage.setItem('omp.previewMode',preview?'1':'0');localStorage.setItem('omp.lastRoute',route);},{preview,route});
  const routeUrl=new URL(page.url());routeUrl.search=preview?'?preview=1':'';
  await page.goto(routeUrl.href);await page.waitForFunction(()=>!!window.ompStudio);await page.waitForTimeout(800);
  if(route==='agent-hub')await page.getByRole('button',{name:'Agent Hub',exact:true}).click();
  else {
   await page.getByRole('button',{name:/^统计$|^Statistics$/}).click();
   if(route!=='statistics')await page.locator('nav.page-nav [data-nav="'+route+'"]:not([aria-hidden="true"])').click();
  }
  if(route==='statistics'){
   await page.getByRole('tab',{name:'Frustration',exact:true}).click();
   if(preview){await page.getByRole('button',{name:/估算分析范围与费用|Estimate analysis and cost/}).click();await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:/确认并分析|Confirm and analyze/}).click();}
  }
  if(route==='model-config')await page.locator('#mcTabBenchmark').click();
  if(route==='capabilities'){
   await page.locator('#capTab-ida').click();
   await page.getByRole('heading',{name:/IDA/}).waitFor();
   if(preview){await page.getByRole('combobox',{name:/IDA 数据库|IDA database/}).selectOption({index:1});await page.getByRole('button',{name:/^检查操作$|^Review operation$/}).click();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:/^返回$|^Back$/}).click();}
  }
  await capture((preview?'preview-':'real-')+route);report.checks.push((preview?'preview':'real')+' '+route);
 }
 const previewUrl=new URL(page.url());previewUrl.search='?preview=1';await page.goto(previewUrl.href);
 await page.getByText('选择 gemini3.6flash 随意发送消息后报错…',{exact:true}).first().click();
 const deck=page.getByRole('region',{name:'待处理的审批与提问（演示）'});
 await deck.getByRole('button',{name:'Approve and execute',exact:true}).click();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=','base64');
 await deck.locator('.ask-images input[type=file]').first().setInputFiles({name:'answer.png',mimeType:'image/png',buffer:png});
 await deck.getByRole('img',{name:'回答 / Answer 1',exact:true}).waitFor();
 await deck.getByRole('textbox',{name:'备注 / Note',exact:true}).fill('First question note');
 await deck.getByRole('button',{name:'下一个请求',exact:true}).click();
 await deck.locator('.dk-cell-out').waitFor({state:'detached'});
 await deck.getByRole('textbox',{name:'备注 / Note',exact:true}).fill('Second question note');
 await deck.locator('.ask-images input[type=file]').nth(1).setInputFiles({name:'note.png',mimeType:'image/png',buffer:png});
 await deck.getByRole('img',{name:'备注 / Note 1',exact:true}).waitFor();
 await deck.getByRole('button',{name:'上一个请求',exact:true}).click();
 await deck.locator('.dk-cell-out').waitFor({state:'detached'});
 await deck.getByRole('img',{name:'回答 / Answer 1',exact:true}).waitFor();
 if(await deck.getByRole('textbox',{name:'备注 / Note',exact:true}).inputValue()!=='First question note')throw Error('Ask ownership mismatch');
 await deck.getByRole('button',{name:'删除 / Remove 回答 / Answer 1',exact:true}).click();
 await capture('preview-ask-images');report.checks.push('real Electron Ask image picker, per-question notes and attachments, navigation and removal');
 report.imeScope='CDP composition integration; physical OS IME not manually tested';
 report.status='passed';
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page)await capture('failure').catch(()=>{});}
finally{if(app)await app.close().catch(()=>{});await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
