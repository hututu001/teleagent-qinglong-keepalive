'use strict';
const assert = require('node:assert/strict');
const { PointsService } = require('../lib/points');

const CENTER = '/user/portal/companyStore/userCenter';
const TASK = '/user/portal/companyStore/v3/checkDayTask?theme=light';
const CLAIM = '/user/portal/companyStore/checkTask?type=daily_login';
const task = claimed => ({ code: 200, data: { activity_data: [
  { jump_url: '/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login', action_status: claimed ? 'completed' : 'pending' },
] } });

function fixture(options = {}) {
  let clock = options.at || Date.parse('2026-11-14T00:00:00Z');
  let remoteClaimed = options.remoteClaimed || false;
  const config = { enabled: true, claimTime: '08:05', catchupOnStart: true, pollMinutes: 10, ...options.config };
  const state = options.state || {};
  const calls = [], events = [], waits = [], timers = [], cleared = [];
  let saves = 0;
  const service = new PointsService({
    platform: { request: async (path, request) => {
      calls.push({ path, request });
      if (options.request) return options.request(path, { calls, state, config, get claimed() { return remoteClaimed; }, set claimed(value) { remoteClaimed = value; }, advance(ms) { clock += ms; } });
      if (path === CENTER) return { code: 200, data: { current_points_balance: 0, plan_display_name: 'test-plan' } };
      if (path === TASK) return task(remoteClaimed);
      if (path === CLAIM) { remoteClaimed = true; return { code: 200, data: null }; }
      throw new Error('Unexpected offline path');
    } },
    getConfig: () => config, state, saveState: () => { saves++; },
    notify: { event: async (...args) => events.push(args) },
    log: { info() {}, warn() {}, error() {} },
    now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; },
    setIntervalFn: callback => { const handle = { callback, unref() {} }; timers.push(handle); return handle; },
    clearIntervalFn: handle => cleared.push(handle),
  });
  return { service, calls, events, waits, timers, cleared, state, config,
    get saves() { return saves; }, advance: ms => { clock += ms; } };
}

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('refresh uses only the confirmed points endpoints and preserves a zero balance', async () => {
  const f = fixture();
  const result = await f.service.refresh();
  assert.equal(result.ok, true);
  assert.equal(result.balance, 0);
  assert.equal(result.plan, 'test-plan');
  assert.deepEqual(f.calls.map(c => c.path), [CENTER, TASK]);
  assert.ok(f.calls.every(c => c.request.base === 'points'));
  assert.equal(f.events.length, 0);
});

test('a remotely completed task persists today and does not claim or notify again', async () => {
  const f = fixture({ remoteClaimed: true });
  const result = await f.service.claim();
  assert.equal(result.status, 'already_claimed');
  assert.equal(f.state.lastClaimDate, '2026-11-14');
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 0);
  assert.equal(f.events.length, 0);
  assert.ok(f.saves > 0);
});

test('a persisted claimed date survives service recreation without another request', async () => {
  const f = fixture({ state: { lastClaimDate: '2026-11-14' } });
  assert.equal((await f.service.claim()).status, 'already_claimed');
  assert.equal(f.calls.length, 0);
});

test('manual sign-in sends one success event and becomes idempotent', async () => {
  const f = fixture();
  assert.equal((await f.service.claim()).status, 'claimed');
  assert.equal((await f.service.claim()).status, 'already_claimed');
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], 'signin_success');
  assert.equal(f.service.status().claimedToday, true);
});

test('a lost claim response rechecks the task and avoids a second mutation', async () => {
  const f = fixture({ request: async (path, ctx) => {
    if (path === TASK) return task(ctx.claimed);
    if (path === CLAIM) { ctx.claimed = true; throw new Error('response lost after acceptance'); }
    if (path === CENTER) return { code: 200, data: { current_points_balance: 100 } };
  } });
  const result = await f.service.claim();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'already_claimed');
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 1);
  assert.deepEqual(f.waits, [5000]);
  assert.equal(f.events.length, 0);
});

test('three task-query failures never send a claim and notify only once', async () => {
  const f = fixture({ request: async () => { throw new Error('offline query failure'); } });
  const result = await f.service.claim();
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.waits, [5000, 5000]);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], 'signin_failure');
  assert.equal(f.state.lastClaimDate, undefined);
});

test('business failures cannot masquerade as a successful sign-in', async () => {
  const f = fixture({ request: async path => path === TASK ? task(false) : { code: 503, data: { success: true } } });
  const result = await f.service.claim();
  assert.equal(result.ok, false);
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 3);
  assert.equal(f.events.filter(e => e[0] === 'signin_failure').length, 1);
  assert.equal(f.state.lastClaimDate, undefined);
});

test('missing task state is not interpreted as an unclaimed task', async () => {
  const f = fixture({ request: async () => ({ code: 200, data: {} }) });
  assert.equal((await f.service.claim()).ok, false);
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 0);
});

test('accepted sign-in remains successful if the later balance read fails', async () => {
  const f = fixture({ request: async path => {
    if (path === TASK) return task(false);
    if (path === CLAIM) return { code: 200, data: null };
    throw new Error('balance unavailable');
  } });
  const result = await f.service.claim();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'claimed');
  assert.match(result.balanceError, /balance/);
  assert.equal(f.state.lastClaimDate, '2026-11-14');
  assert.equal(f.events[0][0], 'signin_success');
});

test('concurrent manual calls cannot send duplicate sign-ins', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ request: async path => {
    if (path === TASK) { await gate; return task(false); }
    if (path === CLAIM) return { code: 200 };
    return { code: 200, data: { current_points_balance: 100 } };
  } });
  const first = f.service.claim();
  assert.equal((await f.service.claim()).status, 'busy');
  release();
  assert.equal((await first).ok, true);
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 1);
});

test('a claim crossing China midnight records the day on which it was accepted', async () => {
  const f = fixture({ at: Date.parse('2026-11-14T15:59:59Z'), request: async (path, ctx) => {
    if (path === TASK) return task(false);
    if (path === CLAIM) { ctx.advance(2000); return { code: 200 }; }
    return { code: 200, data: { current_points_balance: 100 } };
  } });
  await f.service.claim();
  assert.equal(f.state.lastClaimDate, '2026-11-15');
  assert.equal(f.service.status().claimedToday, true);
});

test('startup catchup claims a missed task after its configured time and start is idempotent', async () => {
  const f = fixture({ at: Date.parse('2026-11-14T01:00:00Z') });
  await f.service.start();
  await f.service.start();
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 1);
  assert.equal(f.state.lastResult.source, 'catchup');
  assert.equal(f.timers.length, 1);
  f.service.stop();
  assert.equal(f.cleared.length, 1);
});

test('startup before the configured time never claims early even when catchup is enabled', async () => {
  const f = fixture({ at: Date.parse('2026-11-14T00:00:00Z') });
  await f.service.start();
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 0);
  f.advance(5 * 60000);
  await f.service.tick();
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 1);
  f.service.stop();
});

test('startup after the scheduled time respects disabled catchup', async () => {
  const f = fixture({ at: Date.parse('2026-11-14T02:00:00Z'), config: { catchupOnStart: false } });
  await f.service.start();
  await f.service.tick();
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 0);
  f.service.stop();
});

test('scheduled sign-in uses China time and runs once for its date', async () => {
  const f = fixture({ at: Date.parse('2026-11-14T00:04:00Z'), config: { catchupOnStart: false } });
  await f.service.start();
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 0);
  f.advance(60000);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.filter(c => c.path === CLAIM).length, 1);
  assert.equal(f.state.lastResult.source, 'scheduled');
  assert.equal(f.state.lastScheduledDate, '2026-11-14');
  f.service.stop();
});

test('disabled automatic service makes no platform calls', async () => {
  const f = fixture({ config: { enabled: false } });
  await f.service.start();
  assert.equal(f.calls.length, 0);
  f.service.stop();
});

(async () => {
  let failures = 0;
  for (const item of cases) {
    try { await item.run(); console.log('PASS ' + item.name); }
    catch (error) { failures++; console.error('FAIL ' + item.name + '\n' + error.stack); }
  }
  console.log(`POINTS ${cases.length - failures} passed / ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
