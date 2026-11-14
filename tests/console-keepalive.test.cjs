'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KeepaliveService } = require('../lib/keepalive');
const { EVENTS } = require('../lib/notify');

const target = 'selected-instance';
const baseTime = Date.parse('2026-11-14T09:00:00Z');
const instance = (status, extra = {}) => ({ id: target, status, statusReason: 0, ...extra });
const ticket = () => ({ error: { code: 0 }, data: { connectURL: 'https://pc.ctyun.cn/#/fullview?token=OFFLINE_TEST_ONLY' } });

function fixture(handlers = {}, options = {}) {
  const config = { enabled: true, refreshSec: 300, ...options.config };
  const calls = [], notes = [], sent = [], logs = [], sleeps = [];
  const counts = { list: 0, start: 0, refresh: 0, connect: 0 };
  const flags = { ...Object.fromEntries(EVENTS.map(event => [event.key, event.defaultEnabled])), ...options.events };
  const routes = { list: [instance(100)], start: [{}], refresh: [{}], connect: [ticket()], ...handlers };
  const timers = new Map();
  let now = baseTime, sequence = 0;
  async function response(route, request = {}) {
    const index = counts[route]++;
    calls.push({ route, ...request, at: now });
    const handler = routes[route];
    const step = typeof handler === 'function' ? await handler({ index, now, counts: { ...counts }, request })
      : handler[Math.min(index, handler.length - 1)];
    if (step instanceof Error) throw step;
    if (step?.elapsedMs) {
      if (step.elapsedMs > (request.timeoutMs ?? 20000)) {
        now += request.timeoutMs ?? 20000;
        throw new Error('offline request timed out');
      }
      now += step.elapsedMs;
    }
    return step;
  }
  const platform = {
    instanceId: target,
    instance: options => response('list', options),
    action: name => response(name, { body: { id: platform.instanceId } }),
    request: (path, options) => response(path.split('/').pop(), options),
  };
  const service = new KeepaliveService({
    platform, getConfig: () => config,
    notify: { event: async (key, title, content) => {
      notes.push({ key, title, content });
      if (options.notifyError) throw new Error('offline notification failed');
      if (flags[key]) sent.push({ key, title, content });
    } },
    log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (scope, message) => logs.push({ level, scope, message })])),
    clock: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { service, platform, config, calls, counts, notes, sent, logs, sleeps, timers,
    get now() { return now; },
    async fireNext() {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      assert.ok(timer, 'Expected a scheduled timer');
      timers.delete(id);
      now = Math.max(now, timer.at);
      return timer.callback();
    } };
}

test('a successful run refreshes before taking a ticket and defaults to silence', async () => {
  const f = fixture({ list: [instance(100, { statusReason: 10 })] });
  const result = await f.service.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(call => call.route), ['list', 'refresh', 'connect']);
  assert.ok(f.calls.filter(call => call.body).every(call => call.body.id === target));
  assert.equal(f.sent.length, 0);
  const status = f.service.status();
  assert.equal(status.runs, 1);
  assert.equal(status.failures, 0);
  assert.equal(status.lastStatusReason, 10);
  assert.equal(status.running, false);
  assert.ok(status.lastSuccessAt);
  assert.ok(!JSON.stringify(status).includes('OFFLINE_TEST_ONLY'));
});

test('full workflow retries transient refresh failures and sends no failure alert after recovery', async () => {
  const f = fixture({ refresh: [new Error('offline transient refresh error'), {}] });
  const result = await f.service.run();
  assert.equal(result.attempts, 2);
  assert.deepEqual(f.counts, { list: 2, start: 0, refresh: 2, connect: 1 });
  assert.deepEqual(f.sleeps, [5000]);
  assert.equal(f.sent.length, 0);
});

test('three refresh business failures notify once and never connect', async () => {
  const f = fixture({ refresh: [{ error: { code: 9002 } }] });
  const result = await f.service.run();
  assert.equal(result.ok, false);
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 3, connect: 0 });
  assert.deepEqual(f.sent.map(event => event.key), ['keepalive_failure']);
  assert.equal(f.service.status().failures, 1);
});

test('three ticket errors do not log or expose the ticket URL in status', async () => {
  const f = fixture({ connect: [new Error('offline failure https://pc.ctyun.cn/#/fullview?token=OFFLINE_TEST_ONLY')] });
  assert.equal((await f.service.run()).ok, false);
  assert.equal(f.counts.connect, 3);
  assert.ok(!JSON.stringify({ status: f.service.status(), logs: f.logs }).includes('OFFLINE_TEST_ONLY'));
});

test('a sleeping instance starts once, waits for readiness and only sends enabled wake events', async () => {
  const f = fixture({ list: [instance(3), instance(1), instance(100)] }, { events: { instance_woke: true } });
  const result = await f.service.run();
  assert.equal(result.woke, true);
  assert.equal(f.counts.start, 1);
  assert.equal(f.service.status().wakes, 1);
  assert.deepEqual(f.sent.map(event => event.key), ['instance_woke']);
});

test('a timed-out start is not repeated after the next attempt sees a transition', async () => {
  const f = fixture({ list: [instance(3), instance(1), instance(100)], start: [new Error('offline start timeout')] });
  assert.equal((await f.service.run()).ok, true);
  assert.equal(f.counts.start, 1);
  assert.equal(f.counts.connect, 1);
  assert.equal(f.sent.length, 0);
});

for (const status of [1, 2, 5, 6]) {
  test(`transition ${status} waits without start and refreshes only after readiness`, async () => {
    const f = fixture({ list: [instance(status), instance(100)] });
    assert.equal((await f.service.run()).ok, true);
    assert.deepEqual(f.calls.map(call => call.route), ['list', 'list', 'refresh', 'connect']);
    assert.equal(f.counts.start, 0);
  });
}

test('reset and unknown states never request start, refresh or connect', async () => {
  for (const status of [7, 8, 101]) {
    const f = fixture({ list: [instance(status)] });
    assert.equal((await f.service.run()).ok, false);
    assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 0, connect: 0 });
    assert.equal(f.sent.length, 1);
  }
});

test('readiness deadline includes HTTP time and limits each list request to remaining time', async () => {
  const f = fixture({
    list: ({ index, now }) => index === 0 ? instance(3)
      : now >= baseTime + 65000 ? instance(100) : instance(1, { elapsedMs: 20000 }),
  });
  assert.equal((await f.service.run()).ok, true);
  assert.equal(f.now - baseTime, 65000);
  assert.equal(f.counts.start, 1);
  assert.ok(f.calls.filter(call => call.route === 'list').every(call => call.timeoutMs <= 20000));
});

test('an instance that never becomes ready never refreshes or connects', async () => {
  const f = fixture({ list: [instance(5)] });
  assert.equal((await f.service.run()).ok, false);
  assert.equal(f.now - baseTime, 190000);
  assert.equal(f.counts.start, 0);
  assert.equal(f.counts.refresh, 0);
  assert.equal(f.counts.connect, 0);
  assert.equal(f.sent.length, 1);
});

test('recovery from a previous failed run is controlled by its notification switch', async () => {
  let failing = true;
  const f = fixture({ list: () => failing ? new Error('offline list failed') : instance(100) },
    { events: { keepalive_recovered: true } });
  await f.service.run();
  failing = false;
  const result = await f.service.run();
  assert.equal(result.recovered, true);
  assert.deepEqual(f.sent.map(event => event.key), ['keepalive_failure', 'keepalive_recovered']);
});

test('notification delivery errors do not repeat a successful cloud workflow', async () => {
  const f = fixture({}, { notifyError: true, events: { keepalive_success: true } });
  assert.equal((await f.service.run()).ok, true);
  assert.deepEqual(f.counts, { list: 1, start: 0, refresh: 1, connect: 1 });
  assert.equal(f.service.status().failures, 0);
  assert.ok(f.logs.some(log => log.message.includes('通知失败')));
});

test('concurrent runs share one workflow', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture({ list: () => pending });
  const first = f.service.run();
  const second = f.service.run();
  assert.equal(first, second);
  resolve(instance(100));
  await first;
  assert.equal(f.counts.list, 1);
  assert.equal(f.service.status().runs, 1);
});

test('an instance selection change prevents actions based on the old instance state', async () => {
  let f;
  f = fixture({ list: () => { f.platform.instanceId = 'changed-instance'; return instance(3); } });
  assert.equal((await f.service.run()).ok, false);
  assert.deepEqual(f.counts, { list: 1, start: 0, refresh: 0, connect: 0 });
});

test('scheduler waits at least 60 seconds after each completed run and keeps one timer', async () => {
  const f = fixture({}, { config: { refreshSec: 1 } });
  f.service.start();
  assert.equal(f.timers.size, 1);
  await f.fireNext();
  assert.equal(f.service.status().runs, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(Date.parse(f.service.status().nextRunAt) - f.now, 60000);
  f.service.start();
  f.service.start();
  assert.equal(f.timers.size, 1);
  f.service.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.service.status().nextRunAt, null);
});

test('defer survives stop/start configuration refresh without duplicate timers', async () => {
  const f = fixture();
  f.service.start();
  f.service.defer(120000);
  assert.equal(Date.parse(f.service.status().nextRunAt), baseTime + 120000);
  f.service.stop();
  f.service.start();
  assert.equal(f.timers.size, 1);
  assert.equal(Date.parse(f.service.status().nextRunAt), baseTime + 120000);
  await f.fireNext();
  assert.equal(f.service.status().runs, 1);
  assert.equal(f.timers.size, 1);
});

test('stopping an in-flight run prevents scheduling another run', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture({ list: () => pending });
  const run = f.service.run();
  f.service.start();
  f.service.stop();
  resolve(instance(100));
  await run;
  assert.equal(f.timers.size, 0);
  assert.equal(f.service.status().running, false);
});

test('automatic disabling cancels timers while a manual check remains available', async () => {
  const f = fixture({}, { config: { enabled: false } });
  f.service.start();
  assert.equal(f.timers.size, 0);
  assert.equal(f.service.status().state, 'disabled');
  assert.equal((await f.service.run()).ok, true);
  assert.equal(f.timers.size, 0);
});
