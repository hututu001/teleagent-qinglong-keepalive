'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../server');

async function fixture({ credentials = {}, fetchImpl } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-console-test-'));
  fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify(credentials));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ keepalive: { enabled: false }, points: { enabled: false } }));
  const app = createApplication({
    dataDir,
    env: { TA_PANEL_USER: 'test-admin', TA_PANEL_PASSWORD: 'offline-test-password' },
    fetchImpl: fetchImpl || (async () => { throw new Error('unexpected network request in test'); }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(url, { method = 'GET', body, origin, useCookie = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    if (useCookie && cookie) headers.Cookie = cookie;
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    if (response.status !== 204) { try { data = await response.clone().json(); } catch {} }
    return { response, data };
  }
  async function login() {
    return request('/api/panel/login', { method: 'POST', body: { user: 'test-admin', password: 'offline-test-password' } });
  }
  async function close() {
    app.stopBackground();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { app, request, login, close };
}

test('console requires panel login, serves dashboard and returns secret-free config', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const unauthorized = await f.request('/api/status');
  assert.equal(unauthorized.response.status, 401);
  const login = await f.login();
  assert.equal(login.response.status, 200);
  const dashboard = await f.request('/');
  assert.equal(dashboard.response.status, 200);
  assert.match(await dashboard.response.text(), /TeleAgent 工作台/);
  const save = await f.request('/api/config', { method: 'POST', body: { notify: { webhook: '123e4567-e89b-12d3-a456-426614174000', secret: 'offline-secret', enabled: true } } });
  assert.equal(save.response.status, 200);
  assert.equal(save.data.config.notify.hasWebhook, true);
  assert.equal(save.data.config.notify.hasSecret, true);
  assert.equal(JSON.stringify(save.data).includes('offline-secret'), false);
  assert.equal(JSON.stringify(save.data).includes('123e4567-e89b-12d3-a456-426614174000'), false);
});

test('cross-origin writes are rejected before config changes', async t => {
  const f = await fixture();
  t.after(() => f.close());
  await f.login();
  const denied = await f.request('/api/config', { method: 'POST', origin: 'https://attacker.invalid', body: { keepalive: { enabled: true } } });
  assert.equal(denied.response.status, 403);
  assert.equal(f.app.store.config.keepalive.enabled, false);
});

test('cloud restart requires the exact confirmation phrase and sends no request otherwise', async t => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected request'); };
  const f = await fixture({ credentials: { operationToken: 'OFFLINE_TEST_TOKEN', instanceId: 'instance-1' }, fetchImpl });
  t.after(() => f.close());
  await f.login();
  const result = await f.request('/api/power/restart', { method: 'POST', body: {} });
  assert.equal(result.response.status, 400);
  assert.equal(calls, 0);
});

test('desktop connection only returns an HTTPS ticket from the official desktop host', async t => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    const data = String(url).endsWith('/instance/list')
      ? { code: 0, data: [{ id: 'instance-1', status: 100 }] }
      : { error: { code: 0 }, data: { connectURL: 'https://pc.ctyun.cn/#/fullview?token=OFFLINE_ONLY' } };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const f = await fixture({ credentials: { operationToken: 'OFFLINE_TEST_TOKEN', instanceId: 'instance-1' }, fetchImpl });
  t.after(() => f.close());
  await f.login();
  const opened = await f.request('/api/desktop/open', { method: 'POST', body: {} });
  assert.equal(opened.response.status, 200);
  assert.equal(new URL(opened.data.url).hostname, 'pc.ctyun.cn');
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
  assert.equal(JSON.stringify(f.app.status()).includes('OFFLINE_ONLY'), false);
});

test('panel password configured by environment survives application restarts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-console-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, env: { TA_PANEL_USER: 'test-admin', TA_PANEL_PASSWORD: 'offline-test-password' }, fetchImpl: async () => { throw new Error('unused'); } };
  const first = createApplication(options);
  const second = createApplication(options);
  assert.equal(second.panelAuth.verify('test-admin', 'offline-test-password'), true);
  assert.equal(second.panelAuth.verify('test-admin', 'different-password'), false);
  first.stopBackground(); second.stopBackground();
});
