'use strict';

// Entirely offline: the helper runs in a VM whose fetch and notifier are stubs.
// No credentials are loaded and no real network/notification call is possible.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'qinglong-keepalive.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const entryIndex = source.lastIndexOf('\nmain().catch(');
assert.ok(entryIndex >= 0, 'Expected a main().catch(...) entry point');
const declarations = source.slice(0, entryIndex);
const target = 'selected-instance';
const baseTime = Date.parse('2026-11-14T09:00:00Z');

const response = (payload, status = 200, rawText) => ({ payload, status, ...(rawText === undefined ? {} : { rawText }) });
const list = (status) => response({ error: { code: 0 }, data: [
  { id: 'other-instance', status: 100 }, { id: target, status },
] });
const started = () => response({ error: { code: 0 }, data: {} });
const connected = () => response({ error: { code: 0 }, data: {
  connectURL: 'https://pc.ctyun.cn/#/fullview?token=OFFLINE_TEST_ONLY',
} });
const businessError = (message) => response({ error: { code: 1234, message } });

function fixture(handlers, env = {}) {
  const calls = [], notes = [], logs = [], sleeps = [];
  const counts = { list: 0, start: 0, refresh: 0, connect: 0 };
  const routeHandlers = { refresh: [response(undefined, 204, '')], ...handlers };
  let clockMs = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [baseTime + clockMs])); }
    static now() { return baseTime + clockMs; }
  }
  const print = (...parts) => logs.push(parts.join(' '));
  const context = {
    Buffer, URL,
    Date: ClockDate,
    performance: { now: () => clockMs },
    AbortSignal: { timeout: (timeoutMs) => ({ offline: true, timeoutMs }) },
    process: { env: {
      TELEAGENT_TOKEN: 'offline#OFFLINE_TEST_ONLY',
      TELEAGENT_INSTANCE_ID: target,
      ...env,
    } },
    console: { log: print, warn: print, error: print },
    setTimeout(callback, ms = 0) {
      sleeps.push(ms);
      clockMs += Number(ms);
      queueMicrotask(callback);
      return sleeps.length;
    },
    clearTimeout() {},
    require(id) {
      assert.match(id, /\/sendNotify\.js$/, 'VM may only import the stub notifier');
      return { sendNotify: async (title, content) => {
        notes.push({ title, content, counts: { ...counts }, clockMs });
      } };
    },
    fetch: async (url, options = {}) => {
      const route = String(url).slice(String(url).lastIndexOf('/') + 1);
      assert.ok(Object.hasOwn(counts, route), 'Unexpected offline route: ' + route);
      const index = counts[route]++;
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      calls.push({ route, body, clockMs });
      const handler = routeHandlers[route];
      assert.ok(handler !== undefined, 'No offline response for ' + route);
      let step;
      if (typeof handler === 'function') {
        step = await handler({ index, clockMs, counts: { ...counts } });
      } else {
        step = handler[Math.min(index, handler.length - 1)];
      }
      if (step instanceof Error) throw step;
      assert.ok(step && Object.hasOwn(step, 'payload'), 'Invalid offline response for ' + route);
      if (step.elapsedMs) {
        if (options.signal?.timeoutMs != null && step.elapsedMs > options.signal.timeoutMs) {
          clockMs += options.signal.timeoutMs;
          const error = new Error('offline request exceeded its timeout');
          error.name = 'TimeoutError';
          throw error;
        }
        clockMs += step.elapsedMs;
      }
      const status = step.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        statusText: status === 200 ? 'OK' : 'OFFLINE_ERROR',
        text: async () => Object.hasOwn(step, 'rawText') ? step.rawText : JSON.stringify(step.payload),
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(declarations + '\nthis.testApi = { main, keepAliveOne };', context, { timeout: 1000 });
  return {
    calls, counts, notes, logs, sleeps, context,
    run: () => context.testApi.main(),
    get clockMs() { return clockMs; },
  };
}

function assertSilentSuccess(f) {
  assert.equal(f.context.process.exitCode || 0, 0);
  assert.equal(f.notes.length, 0, 'A successful run must not send any notification');
  assert.ok(f.calls.filter(c => c.body).every(c => c.body.id === target), 'Only the selected instance may be mutated');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('query fails once, the second attempt succeeds silently', async () => {
  const f = fixture({
    list: [new TypeError('offline transient query failure'), list(100)],
    connect: [connected()],
  });
  await f.run();
  assert.equal(f.counts.list, 2);
  assert.equal(f.counts.connect, 1);
  assert.equal(f.counts.start, 0);
  assert.ok(f.sleeps.includes(5000), 'Retry must wait five seconds');
  assertSilentSuccess(f);
});

test('three query failures produce exactly one final failure notification', async () => {
  const f = fixture({ list: [businessError('offline query failure')] });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 0, connect: 0 });
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].counts.list, 3, 'Notification must be sent only after the third attempt');
  assert.equal(f.sleeps.filter(ms => ms === 5000).length, 2);
});

test('three rejected starts with a still-sleeping instance notify only after the final attempt', async () => {
  const f = fixture({ list: [list(3)], start: [businessError('offline start rejection')] });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 3, refresh: 0, connect: 0 });
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].counts.start, 3);
  assert.ok(f.calls.filter(c => c.body).every(c => c.body.id === target));
});

test('an account containing only another instance never starts or connects it', async () => {
  const f = fixture({ list: [response({ error: { code: 0 }, data: [{ id: 'other-instance', status: 3 }] })] });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 0, connect: 0 });
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].counts.list, 3);
});

test('two ticket failures followed by third-attempt success are silent', async () => {
  const f = fixture({
    list: [list(100)],
    connect: [
      businessError('offline connect error'),
      response({ error: { code: 0 }, data: {} }),
      connected(),
    ],
  });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 3, connect: 3 });
  assertSilentSuccess(f);
});

test('a sleeping instance is started once and becomes ready silently', async () => {
  const f = fixture({ list: [list(3), list(1), list(100)], start: [started()], connect: [connected()] });
  await f.run();
  assert.equal(f.counts.start, 1);
  assert.equal(f.counts.connect, 1);
  assertSilentSuccess(f);
});

test('start request times out, retry sees transition/ready and never starts again', async () => {
  const timeout = new Error('offline start request timed out');
  timeout.name = 'TimeoutError';
  const f = fixture({ list: [list(3), list(1), list(100)], start: [timeout], connect: [connected()] });
  await f.run();
  assert.equal(f.counts.start, 1);
  assert.equal(f.counts.connect, 1);
  assertSilentSuccess(f);
});

test('readiness deadline expires, retry waits through transition without a second start', async () => {
  const f = fixture({
    list: ({ index, clockMs }) => index === 0 ? list(3) : list(clockMs <= 65000 ? 1 : 100),
    start: [started()], connect: [connected()],
  });
  await f.run();
  assert.equal(f.counts.start, 1);
  assert.equal(f.counts.connect, 1);
  assert.ok(f.sleeps.includes(5000), 'The expired readiness attempt must retry');
  assert.ok(f.clockMs < 100000, 'The readiness deadline must be bounded');
  assertSilentSuccess(f);
});

test('reset status never starts or connects and only notifies after three attempts', async () => {
  const f = fixture({ list: [list(7)] });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 0, connect: 0 });
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].counts.list, 3);
});

for (const transitional of [1, 2, 5, 6]) {
  test('transitional status ' + transitional + ' waits read-only for readiness', async () => {
    const f = fixture({ list: [list(transitional), list(100)], connect: [connected()] });
    await f.run();
    assert.equal(f.counts.start, 0);
    assert.equal(f.counts.connect, 1);
    assertSilentSuccess(f);
  });

  test('transitional status ' + transitional + ' never refreshes before readiness', async () => {
    const f = fixture({ list: [list(transitional)] });
    await f.run();
    assert.equal(f.counts.start, 0);
    assert.equal(f.counts.refresh, 0);
    assert.equal(f.counts.connect, 0);
    assert.equal(f.context.process.exitCode, 1);
    assert.equal(f.notes.length, 1);
    assert.ok(f.clockMs <= 190000, 'Three readiness attempts must stay bounded');
  });
}

test('an empty successful refresh precedes the ticket request and stays silent', async () => {
  const f = fixture({ list: [list(100)], connect: [connected()] });
  await f.run();
  assert.deepEqual(f.calls.map(c => c.route), ['list', 'refresh', 'connect']);
  assert.deepEqual(f.counts, { list: 1, start: 0, refresh: 1, connect: 1 });
  assertSilentSuccess(f);
});

test('a transient refresh failure retries the complete flow and succeeds silently', async () => {
  const f = fixture({
    list: [list(100)],
    refresh: [new TypeError('offline transient refresh failure'), response(undefined, 204, '')],
    connect: [connected()],
  });
  await f.run();
  assert.deepEqual(f.calls.map(c => c.route), ['list', 'refresh', 'list', 'refresh', 'connect']);
  assert.deepEqual(f.counts, { list: 2, start: 0, refresh: 2, connect: 1 });
  assert.equal(f.sleeps.filter(ms => ms === 5000).length, 1);
  assertSilentSuccess(f);
});

test('three refresh failures notify once after the third attempt and never connect', async () => {
  const f = fixture({ list: [list(100)], refresh: [new TypeError('offline refresh unavailable')] });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 3, connect: 0 });
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].counts.refresh, 3);
  assert.equal(f.notes[0].counts.connect, 0);
  assert.equal(f.sleeps.filter(ms => ms === 5000).length, 2);
  assert.ok(f.calls.filter(c => c.body).every(c => c.body.id === target));
});

test('a refresh business error is never treated as success', async () => {
  const f = fixture({
    list: [list(100)],
    refresh: [response({ error: { code: 9002, message: 'offline rejected activity refresh' }, data: {} })],
  });
  await f.run();
  assert.deepEqual(f.counts, { list: 3, start: 0, refresh: 3, connect: 0 });
  assert.equal(f.context.process.exitCode, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].counts.refresh, 3);
  assert.match(f.notes[0].content, /9002/);
  assert.ok(f.logs.every(line => !line.includes('活动刷新请求成功')));
});

test('HTTP error is retried even if its JSON body resembles success', async () => {
  const validList = list(100).payload;
  const f = fixture({ list: [response(validList, 503), list(100)], connect: [connected()] });
  await f.run();
  assert.equal(f.counts.list, 2);
  assert.equal(f.counts.connect, 1);
  assertSilentSuccess(f);
});

test('missing list data is retried and can recover silently', async () => {
  const f = fixture({ list: [response({ error: { code: 0 } }), list(100)], connect: [connected()] });
  await f.run();
  assert.equal(f.counts.list, 2);
  assert.equal(f.counts.start, 0);
  assert.equal(f.counts.connect, 1);
  assertSilentSuccess(f);
});

test('an empty successful start response is accepted and recovery stays silent', async () => {
  const f = fixture({
    list: [list(3), list(100)], start: [response(undefined, 204, '')], connect: [connected()],
  });
  await f.run();
  assert.equal(f.counts.start, 1);
  assert.equal(f.counts.connect, 1);
  assertSilentSuccess(f);
});

test('readiness deadline includes HTTP time rather than only sleep time', async () => {
  const f = fixture({
    list: ({ index, clockMs }) => {
      if (index === 0) return list(3);
      if (clockMs >= 65000) return list(100);
      return { ...list(1), elapsedMs: 20000 };
    },
    start: [started()], connect: [connected()],
  });
  await f.run();
  assert.equal(f.clockMs, 65000, '60 seconds waiting plus five-second retry should see the ready instance');
  assert.equal(f.counts.start, 1);
  assert.equal(f.counts.connect, 1);
  assert.equal(f.sleeps.filter(ms => ms === 5000).length, 1);
  assertSilentSuccess(f);
});

test('business error is retried even if a connectURL is included', async () => {
  const contradictory = connected().payload;
  contradictory.error = { code: 9001, message: 'offline rejected ticket' };
  const f = fixture({ list: [list(100)], connect: [response(contradictory), connected()] });
  await f.run();
  assert.equal(f.counts.list, 2);
  assert.equal(f.counts.connect, 2);
  assertSilentSuccess(f);
});

test('legacy notify-all setting cannot enable successful-run messages', async () => {
  const f = fixture({ list: [list(100)], connect: [connected()] }, { TELEAGENT_NOTIFY: 'all' });
  await f.run();
  assertSilentSuccess(f);
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('PASS ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL ' + name + '\n  ' + error.message);
    }
  }
  console.log(`RESULT ${passed} passed / ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
