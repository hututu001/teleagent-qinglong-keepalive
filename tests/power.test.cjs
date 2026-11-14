'use strict';
const assert = require('node:assert/strict');
const { PowerService } = require('../lib/power');

function fixture(options = {}) {
  let clock = options.at || Date.parse('2026-11-14T20:29:00Z'); // Sunday 04:29 in China
  let occupied = options.busy || false;
  const config = { restartPlan: { enabled: false, mode: 'daily', time: '04:30', weekday: 0, ...options.plan } };
  const state = options.state || {};
  const trace = [], events = [], timers = [], cleared = [];
  let saves = 0;
  const service = new PowerService({
    platform: { action: async action => { trace.push(['action', action]); return options.action ? options.action(action) : { error: { code: 0 }, data: null }; } },
    getConfig: () => config, state, saveState: () => { saves++; },
    notify: { event: async (...args) => events.push(args) },
    log: { info() {}, warn() {}, error() {} },
    busy: () => occupied, defer: ms => trace.push(['defer', ms]), now: () => clock,
    setIntervalFn: callback => { const handle = { callback, unref() {} }; timers.push(handle); return handle; },
    clearIntervalFn: handle => cleared.push(handle),
  });
  return { service, trace, events, timers, cleared, config, state, get saves() { return saves; },
    advance: ms => { clock += ms; }, setBusy: value => { occupied = value; } };
}

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('restart defers keepalive first and reports acceptance rather than completion', async () => {
  const f = fixture();
  const result = await f.service.execute('restart');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(f.trace, [['defer', 180000], ['action', 'restart']]);
  assert.equal(f.events[0][0], 'power_success');
});

test('rebuild cannot run without the exact RESET confirmation', async () => {
  const f = fixture();
  for (const value of [undefined, '', 'reset', 'RESET ']) assert.equal((await f.service.execute('rebuild', value)).ok, false);
  assert.equal(f.trace.length, 0);
  assert.equal(f.events.length, 0);
});

test('confirmed rebuild uses the longer keepalive pause', async () => {
  const f = fixture();
  assert.equal((await f.service.execute('rebuild', 'RESET')).ok, true);
  assert.deepEqual(f.trace, [['defer', 300000], ['action', 'rebuild']]);
});

test('cancel calls only the queue cancellation action', async () => {
  const f = fixture();
  assert.equal((await f.service.execute('cancel')).ok, true);
  assert.deepEqual(f.trace, [['action', 'cancel']]);
});

test('arbitrary action names never reach the platform', async () => {
  const f = fixture();
  assert.equal((await f.service.execute('shutdown')).ok, false);
  assert.equal(f.trace.length, 0);
});

test('a platform failure sends one failure event and persists the result', async () => {
  const f = fixture({ action: async () => { throw new Error('offline rejection'); } });
  const result = await f.service.execute('restart');
  assert.equal(result.ok, false);
  assert.equal(f.state.lastResult.ok, false);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], 'power_failure');
  assert.ok(f.saves > 0);
});

test('a business error response is not reported as accepted', async () => {
  const f = fixture({ action: async () => ({ error: { code: 12 } }) });
  assert.equal((await f.service.execute('cancel')).ok, false);
  assert.equal(f.events[0][0], 'power_failure');
});

test('concurrent manual power requests are serialized', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ action: () => gate });
  const first = f.service.execute('cancel');
  assert.equal((await f.service.execute('cancel')).ok, false);
  release({ code: 200 });
  assert.equal((await first).ok, true);
  assert.equal(f.trace.filter(x => x[0] === 'action').length, 1);
});

test('daily restart fires at China time and persists one occurrence per date', async () => {
  const f = fixture({ plan: { enabled: true } });
  await f.service.start();
  assert.equal(f.trace.length, 0);
  assert.equal(f.service.status().nextRestartAt, '2026-11-14T20:30:00.000Z');
  f.advance(60000);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.trace.filter(x => x[0] === 'action').length, 1);
  assert.equal(f.state.lastPlanDate, '2026-11-15');
  assert.equal(f.state.lastResult.source, 'scheduled');
  f.service.stop();
});

test('weekly Sunday plan uses the China weekday even when UTC is Saturday', async () => {
  const f = fixture({ plan: { enabled: true, mode: 'weekly', weekday: 0 } });
  await f.service.start();
  f.advance(60000);
  await f.service.tick();
  assert.equal(f.trace.filter(x => x[0] === 'action').length, 1);
  assert.equal(f.service.status().nextRestartAt, '2026-11-21T20:30:00.000Z');
  f.service.stop();
});

test('busy scheduled restart is skipped, persisted, and never interrupts sign-in', async () => {
  const f = fixture({ plan: { enabled: true }, busy: true });
  await f.service.start();
  f.advance(60000);
  await f.service.tick();
  f.setBusy(false);
  await f.service.tick();
  assert.equal(f.trace.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.state.lastResult.status, 'skipped_busy');
  assert.equal(f.state.lastPlanDate, '2026-11-15');
  f.service.stop();
});

test('a restart after the scheduled time does not backfill a past power operation', async () => {
  const f = fixture({ at: Date.parse('2026-11-15T02:00:00Z'), plan: { enabled: true } });
  await f.service.start();
  await f.service.tick();
  assert.equal(f.trace.length, 0);
  assert.equal(f.service.status().nextRestartAt, '2026-11-15T20:30:00.000Z');
  f.service.stop();
});

test('persistent occurrence prevents another restart when the service is recreated', async () => {
  const f = fixture({ at: Date.parse('2026-11-14T20:29:00Z'), plan: { enabled: true }, state: { lastPlanDate: '2026-11-15' } });
  await f.service.start();
  f.advance(60000);
  await f.service.tick();
  assert.equal(f.trace.length, 0);
  f.service.stop();
});

test('changing a plan to an already passed time schedules its next occurrence', async () => {
  const f = fixture({ plan: { enabled: true, time: '10:00' } });
  await f.service.start();
  f.config.restartPlan.time = '01:00';
  await f.service.tick();
  assert.equal(f.trace.length, 0);
  assert.equal(f.service.status().nextRestartAt, '2026-11-15T17:00:00.000Z');
  f.service.stop();
});

test('disabled plan is inert and starting twice does not register extra timers', async () => {
  const f = fixture();
  await f.service.start();
  await f.service.start();
  assert.equal(f.trace.length, 0);
  assert.equal(f.timers.length, 1);
  f.service.stop();
  assert.equal(f.cleared.length, 1);
});

(async () => {
  let failures = 0;
  for (const item of cases) {
    try { await item.run(); console.log('PASS ' + item.name); }
    catch (error) { failures++; console.error('FAIL ' + item.name + '\n' + error.stack); }
  }
  console.log(`POWER ${cases.length - failures} passed / ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
