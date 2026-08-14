import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackWebAdapter, createLoopbackHttpServer } from '../dist/src/index.js';

function host() { return {
  bootstrap: async () => ({ contractVersion: 1 }),
  query: async (r) => ({ ok: true, queryName: r.queryName, result: {} }),
  command: async (r) => ({ commandName: r.commandName, status: 'accepted', requestId: 'r', acceptedAt: 't' }),
  subscribe: () => () => {},
}; }

test('pairing, csrf, and origin checks', async (t) => {
  const adapter = new LoopbackWebAdapter({ host: host(), origins: ['http://localhost'], pairingCode: '1234' });
  const server = createLoopbackHttpServer(adapter); t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; const url = `http://127.0.0.1:${port}`;
  let r = await fetch(`${url}/api/v1/pair`, { method: 'POST', headers: { Origin: 'http://evil', 'content-type': 'application/json' }, body: '{"code":"1234"}' });
  assert.equal(r.status, 403);
  r = await fetch(`${url}/api/v1/pair`, { method: 'POST', headers: { Origin: 'http://localhost', 'content-type': 'application/json' }, body: '{"code":"1234"}' });
  assert.equal(r.status, 200); const cookie = r.headers.get('set-cookie').split(';')[0]; const csrf = (await r.json()).csrf;
  r = await fetch(`${url}/api/v1/command`, { method: 'POST', headers: { Origin: 'http://localhost', Cookie: cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  r = await fetch(`${url}/api/v1/command`, { method: 'POST', headers: { Origin: 'http://localhost', Cookie: cookie, 'X-Studio-CSRF': csrf, 'content-type': 'application/json' }, body: '{"commandName":"session.resume"}' });
  assert.equal(r.status, 202);
  r = await fetch(`${url}/api/v1/pair`, { method: 'POST', headers: { Origin: 'http://localhost', 'content-type': 'application/json' }, body: '{"code":"1234"}' });
  assert.equal(r.status, 401);
});

test('health contains no sensitive details', async () => {
  const adapter = new LoopbackWebAdapter({ host: host(), origins: ['http://localhost'] });
  const server = createLoopbackHttpServer(adapter); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/health`); assert.deepEqual(await r.json(), { ok: true, protocolVersion: 1 }); server.close();
});
