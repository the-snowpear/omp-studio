import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { probeRemote, deployRemote, attachRemote, runSsh, nodeRemoteCommand } from '../apps/desktop/dist/src/remote/deploy.js';
import { RemoteTerminalManager } from '../apps/desktop/dist/src/remote/terminal.js';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');
const alias = process.argv[2];
if (!alias) throw new Error('SSH alias required');
const profile = { host: alias, id: alias, name: alias };
const environment = await probeRemote(profile);
const marker = `omp-studio-terminal-test-${Date.now()}`;
environment.root = environment.platform === 'win32' ? `${environment.home}\\AppData\\Local\\Temp\\${marker}` : `${environment.home}/.cache/${marker}`;
const installation = await deployRemote(profile, environment, resolve('apps/desktop/dist/remote-host'));
console.log(JSON.stringify({ alias, ...installation }));
const workspace = JSON.parse(await runSsh(profile, nodeRemoteCommand(`const fs=require('node:fs'),p=require('node:path');const root=p.join(${JSON.stringify(environment.root)},'terminal project');fs.mkdirSync(root,{recursive:true});process.stdout.write(JSON.stringify(root));`)));
const transport = await attachRemote(profile, environment, installation);
const remote = { transport, environment, ...installation };
const manager = new RemoteTerminalManager({ get: () => remote, profile: () => profile, assertWritable: () => {}, authentication: () => undefined });
const terminal = new Terminal({ cols: 150, rows: 35, allowProposedApi: true });
let info;
let output = '';
let exited = false;
const pendingInput = [];
terminal.onData(data => { if (info) manager.write(1, info.id, data); else pendingInput.push(data); });
const waitUntil = async (predicate, label) => {
  const deadline = Date.now() + 25_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label}: ${output.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
try {
  const projects = await transport.registerWorkspace(workspace);
  info = await manager.create(1, alias, projects.activeWorkspaceId, { cols: 150, rows: 35 }, {
    onData: event => { output += event.data; terminal.write(event.data); },
    onExit: () => { exited = true; },
  });
  for (const data of pendingInput) manager.write(1, info.id, data);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const command = environment.platform === 'win32'
    ? `if ((Get-Location).Path -eq '${workspace.replaceAll("'", "''")}') { [Console]::WriteLine('CWD_'+'OK') }; [Console]::WriteLine('OMP_'+'TERMINAL_OK')\r`
    : `test "$PWD" = '${workspace.replaceAll("'", "'\\''")}' && printf 'CWD_%s\\n' OK; printf 'OMP_%s\\n' TERMINAL_OK\r`;
  manager.write(1, info.id, command);
  await waitUntil(() => output.includes('OMP_TERMINAL_OK') && output.includes('CWD_OK'), 'Terminal cwd/input/output failed');
  manager.resize(1, info.id, 160, 40);
  terminal.resize(160, 40);
  manager.write(1, info.id, environment.platform === 'win32' ? 'Start-Sleep -Seconds 60\r' : 'sleep 60\r');
  await new Promise(resolve => setTimeout(resolve, 500));
  manager.write(1, info.id, '\u0003');
  await new Promise(resolve => setTimeout(resolve, 300));
  manager.write(1, info.id, environment.platform === 'win32' ? "[Console]::WriteLine('CTRL_'+'C_OK')\r" : "printf 'CTRL_%s\\n' C_OK\r");
  await waitUntil(() => output.includes('CTRL_C_OK'), 'Ctrl-C did not interrupt foreground command');
  manager.dispose(1, info.id);
  await waitUntil(() => exited, 'SSH PTY did not exit');
  console.log('PTY_CWD_INPUT_OUTPUT_RESIZE_CTRL_C_CLOSE_OK', alias);
} finally {
  if (info) manager.dispose(1, info.id);
  terminal.dispose();
  try { await transport.peer.request('shutdown'); } finally { await transport.close(); }
}
