import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWebClientTransport, LoopbackWebAdapter, createLoopbackHttpServer } from '../dist/src/index.js';

function host() { return {
  bootstrap: async () => ({ contractVersion: 2 }),
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

test('a paired browser can bootstrap with a normal same-origin GET without an Origin header', async t => {
  const origins = ['http://localhost'];
  const adapter = new LoopbackWebAdapter({ host: host(), origins, pairingCode: '1234' });
  const server = createLoopbackHttpServer(adapter);
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  origins.push(baseUrl);
  let cookie = '', getOrigin;
  const client = new BrowserWebClientTransport({ baseUrl, fetcher: async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.method === 'GET') {
      getOrigin = headers.get('Origin');
      headers.set('Sec-Fetch-Site', 'same-origin');
    } else headers.set('Origin', baseUrl);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(url, { ...init, headers });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  } });
  await client.pair('1234');
  assert.deepEqual(await client.bootstrap(), { contractVersion: 2 });
  assert.equal(getOrigin, null);
  assert.equal((await client.command({ commandName: 'session.resume' })).status, 'accepted');
  const crossSite = await fetch(`${baseUrl}/api/v1/bootstrap`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(adapter.authenticateWebSocket({ url: '/api/v1/events', method: 'GET', headers: { host: new URL(baseUrl).host, cookie } }), undefined);
  await client.close();
});

test('closing a context releases local sockets even when the Host is unreachable', async () => {
  let requests = 0, closed = 0;
  const client = new BrowserWebClientTransport({
    baseUrl: 'http://localhost', contextId: 'conversation',
    fetcher: async () => { requests++; throw new Error('offline'); },
    webSocketFactory: () => ({ send() {}, close() { closed++; } }),
  });
  client.subscribe({ scope: 'all' }, () => {});
  await assert.rejects(client.close(), /offline/);
  await assert.rejects(client.bootstrap(), /transport_closed/);
  await assert.rejects(client.close(), /offline/);
  assert.equal(closed, 1);
  assert.equal(requests, 1);
});

test('revoking a browser session releases a context that is still opening', async t => {
  const opening = Promise.withResolvers();
  const requested = Promise.withResolvers();
  let closed = 0;
  const adapter = new LoopbackWebAdapter({
    host: { ...host(), openContext: async () => { requested.resolve(); return opening.promise; } },
    origins: ['http://localhost'], pairingCode: '1234',
  });
  const server = createLoopbackHttpServer(adapter);
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const pair = await fetch(`${url}/api/v1/pair`, { method: 'POST', headers: { Origin: 'http://localhost', 'content-type': 'application/json' }, body: '{"code":"1234"}' });
  const cookie = pair.headers.get('set-cookie').split(';')[0];
  const csrf = (await pair.json()).csrf;
  const headers = { Origin: 'http://localhost', Cookie: cookie, 'X-Studio-CSRF': csrf, 'content-type': 'application/json' };
  const pending = fetch(`${url}/api/v1/context/open`, { method: 'POST', headers, body: '{"workspaceId":"workspace"}' });
  await requested.promise;
  const revoked = await fetch(`${url}/api/v1/session/revoke`, { method: 'POST', headers, body: '{}' });
  assert.equal(revoked.status, 200);
  opening.resolve({ ...host(), close: async () => { closed++; } });
  assert.equal((await pending).status, 401);
  assert.equal(closed, 1);
});

test('a WebSocket reconnect to a closed context is refused without throwing from the upgrade handler', async t => {
  const adapter = new LoopbackWebAdapter({ host: host(), origins: ['http://localhost'], pairingCode: '1234' });
  const server = createLoopbackHttpServer(adapter);
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pair = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/pair`, { method: 'POST', headers: { Origin: 'http://localhost', 'content-type': 'application/json' }, body: '{"code":"1234"}' });
  const cookie = pair.headers.get('set-cookie').split(';')[0];
  await pair.json();
  const result = adapter.authenticateWebSocket({ url: '/api/v1/events?contextId=closed-context', headers: { origin: 'http://localhost', cookie } });
  assert.equal(result, undefined);
});
