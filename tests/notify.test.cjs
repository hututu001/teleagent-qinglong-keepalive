'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifier, EVENTS } = require('../lib/notify');

function reply(payload = { code: 0, msg: 'success' }, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => {
    if (payload instanceof Error) throw payload;
    return payload;
  } };
}

function fixture(overrides = {}, responses = [reply()]) {
  const config = { enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/OFFLINE_TEST_ONLY',
    events: {}, cooldownSec: 1800, ...overrides };
  const calls = [], logs = [];
  let now = 1700000000000;
  const notifier = new Notifier({
    getConfig: () => config,
    clock: () => now,
    log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (scope, message) => logs.push({ level, scope, message })])),
    fetchImpl: async (url, options) => {
      const index = calls.length;
      calls.push({ url, options, body: JSON.parse(options.body) });
      const step = responses[Math.min(index, responses.length - 1)];
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    },
  });
  return { notifier, config, calls, logs, advance: ms => { now += ms; } };
}

test('notification event defaults match the product switches', () => {
  assert.equal(EVENTS.length, 12);
  assert.deepEqual(EVENTS.filter(event => event.defaultEnabled).map(event => event.key),
    ['keepalive_failure', 'signin_failure', 'auth_failure', 'power_failure']);
  assert.ok(EVENTS.every(event => event.label && event.description));
});

test('disabled channel and disabled success events never send', async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.notifier.event('keepalive_failure', 'Failure', 'offline')).reason, 'disabled');
  f.config.enabled = true;
  assert.equal((await f.notifier.event('keepalive_success', 'Success', 'offline')).reason, 'event_disabled');
  f.config.events.keepalive_failure = false;
  assert.equal((await f.notifier.event('keepalive_failure', 'Failure', 'offline')).reason, 'event_disabled');
  assert.equal(f.calls.length, 0);
});

test('FSKEY UUID expands to a Feishu webhook and uses a text body', async () => {
  const f = fixture({ webhook: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(await f.notifier.event('keepalive_failure', '巡检失败', '三次尝试失败'), { sent: true });
  assert.equal(f.calls[0].url, 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000001');
  assert.deepEqual(f.calls[0].body, { msg_type: 'text', content: { text: '巡检失败\n三次尝试失败' } });
  assert.equal(f.calls[0].options.method, 'POST');
});

test('signature matches the official Feishu HMAC vector', async () => {
  const f = fixture({ secret: 'offline-secret' });
  await f.notifier.event('keepalive_failure', 'Failure', 'offline');
  assert.equal(f.calls[0].body.timestamp, '1700000000');
  assert.equal(f.calls[0].body.sign, 'Tkukxd/Lm7XXOYvNi3V5HBXONS3kj75a59zVLD6t65E=');
});

test('an explicit test bypasses disabled switches and cooldown but requires a webhook', async () => {
  const f = fixture({ enabled: false, events: Object.fromEntries(EVENTS.map(event => [event.key, false])) });
  await f.notifier.test();
  await f.notifier.test();
  assert.equal(f.calls.length, 2);
  assert.equal(f.notifier.status().lastEvent, 'test');
  assert.ok(f.notifier.status().lastTestAt);
  f.config.webhook = '';
  await assert.rejects(f.notifier.test(), /未配置飞书 Webhook/);
  assert.equal(f.calls.length, 2);
});

test('failed HTTP delivery does not consume cooldown and successful delivery does', async () => {
  const f = fixture({}, [reply({ code: 0 }, 503), reply()]);
  await assert.rejects(f.notifier.event('keepalive_failure', 'Failure', 'offline'), /HTTP 503/);
  await f.notifier.event('keepalive_failure', 'Failure', 'offline');
  assert.equal((await f.notifier.event('keepalive_failure', 'Failure', 'offline')).reason, 'cooldown');
  assert.equal(f.calls.length, 2);
  f.advance(1800000);
  await f.notifier.event('keepalive_failure', 'Failure', 'offline');
  assert.equal(f.calls.length, 3);
  assert.equal(f.notifier.status().sent, 2);
  assert.equal(f.notifier.status().failures, 1);
});

test('Feishu business failures and malformed responses reject instead of succeeding', async () => {
  for (const body of [{ code: 19021, msg: 'sign mismatch' }, {}, null, [], new Error('offline invalid JSON')]) {
    const f = fixture({}, [reply(body)]);
    await assert.rejects(f.notifier.event('keepalive_failure', 'Failure', 'offline'));
    assert.equal(f.notifier.status().sent, 0);
    assert.equal(f.notifier.status().failures, 1);
  }
});

test('legacy Feishu StatusCode succeeds while a contradictory code rejects', async () => {
  const f = fixture({}, [reply({ StatusCode: 0 }), reply({ code: 0, StatusCode: 1 })]);
  await f.notifier.test();
  await assert.rejects(f.notifier.test(), /code 0\/1/);
  assert.equal(f.notifier.status().sent, 1);
});

test('cooldown is per event and test messages do not suppress real alerts', async () => {
  const f = fixture();
  await f.notifier.test();
  await f.notifier.event('keepalive_failure', 'Failure', 'offline');
  await f.notifier.event('auth_failure', 'Auth', 'offline');
  assert.equal(f.calls.length, 3);
});

test('concurrent matching events cannot send duplicate messages', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture({}, [() => pending]);
  const first = f.notifier.event('keepalive_failure', 'Failure', 'offline');
  assert.equal((await f.notifier.event('keepalive_failure', 'Failure', 'offline')).reason, 'in_flight');
  resolve(reply());
  await first;
  assert.equal(f.calls.length, 1);
});

test('status and logged network failures do not expose webhook URLs', async () => {
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/OFFLINE_TEST_ONLY';
  const f = fixture({ secret: 'offline-secret' }, [new Error('offline request to ' + url + ' failed')]);
  await assert.rejects(f.notifier.event('keepalive_failure', 'Failure', 'offline'));
  const text = JSON.stringify({ status: f.notifier.status(), logs: f.logs });
  assert.ok(!text.includes(url));
  assert.ok(!text.includes('offline-secret'));
});
