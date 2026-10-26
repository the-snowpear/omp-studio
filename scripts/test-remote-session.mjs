import { attachRemote, probeRemote, runSsh, nodeRemoteCommand } from '../apps/desktop/dist/src/remote/deploy.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function testRemoteSession(profile, environment, installation) {
  let transport = await attachRemote(profile, environment, installation);
  try {
    const workspace = JSON.parse(await runSsh(profile, nodeRemoteCommand(`
      const fs=require('node:fs'),p=require('node:path');
      const dir=p.join(${JSON.stringify(installation.state)},'session-test-project');
      fs.mkdirSync(dir,{recursive:true,mode:448});process.stdout.write(JSON.stringify(dir));
    `)));
    await transport.registerWorkspace(workspace);
    await transport.bootstrap();
    const requestId = `remote-create-${randomUUID()}`;
    let timer;
    let unsubscribe;
    const receipt = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Session creation timed out')), 90_000);
      unsubscribe = transport.subscribe({ scope: 'command', requestId }, event => {
        if (event.kind === 'command.receipt') resolve(event.receipt);
      });
    });
    let result;
    try {
      await transport.command({ commandName: 'session.create', input: {}, requestId, idempotencyKey: requestId });
      result = await receipt;
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const first = await transport.bootstrap();
    assert.equal(first.runtime.status, 'connected');
    assert.ok(first.selected.sessionId);
    await transport.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    transport = await attachRemote(profile, environment, installation);
    const next = await transport.bootstrap();
    assert.equal(next.authority.authorityId, first.authority.authorityId);
    assert.equal(next.authority.authorityEpoch, first.authority.authorityEpoch);
    assert.equal(next.selected.sessionId, first.selected.sessionId);
    assert.equal(next.runtime.status, 'connected');
    console.log('SESSION_CREATED_AND_REATTACHED', JSON.stringify({ runtimeVersion: next.runtime.runtimeVersion, sessionId: next.selected.sessionId }));
  } finally {
    try { await transport.peer.request('shutdown'); } finally { await transport.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [alias, entry, state] = process.argv.slice(2);
  if (!alias || !entry || !state) throw new Error('Usage: node scripts/test-remote-session.mjs <alias> <host-entry> <state>');
  const profile = { host: alias };
  await testRemoteSession(profile, await probeRemote(profile), { entry, state });
}
