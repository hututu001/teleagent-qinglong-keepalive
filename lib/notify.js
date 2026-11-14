'use strict';

const crypto = require('node:crypto');

const EVENTS = Object.freeze([
  ['keepalive_success', '保活巡检成功', '每轮活动刷新和取票成功时通知。', false],
  ['keepalive_failure', '保活最终失败', '完整流程连续三次失败后通知。', true],
  ['keepalive_recovered', '保活故障恢复', '上次巡检失败，本次恢复成功时通知。', false],
  ['instance_woke', '云电脑唤醒成功', '请求启动后恢复到可连接状态时通知。', false],
  ['signin_success', '签到成功', '每日签到成功时通知。', false],
  ['signin_failure', '签到失败', '每日签到失败时通知。', true],
  ['auth_expiring', '登录即将到期', '登录凭据即将到期时通知。', false],
  ['auth_success', '登录更新成功', '登录凭据更新成功时通知。', false],
  ['auth_failure', '登录失效', '登录失效或更新失败时通知。', true],
  ['power_success', '电源操作成功', '手动启动、关机或重启成功时通知。', false],
  ['power_failure', '电源操作失败', '手动启动、关机或重启失败时通知。', true],
  ['service_failure', '后台服务异常', '后台服务任务发生异常时通知。', false],
].map(([key, label, description, defaultEnabled]) => Object.freeze({ key, label, description, defaultEnabled })));

const eventMap = new Map(EVENTS.map(event => [event.key, event]));

function errorText(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[地址已隐藏]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[Token已隐藏]')
    .slice(0, 300);
}

function webhookUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('未配置飞书 Webhook');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return `https://open.feishu.cn/open-apis/bot/v2/hook/${text}`;
  }
  let url;
  try { url = new URL(text); } catch { throw new Error('飞书 Webhook 地址无效'); }
  if (url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)
      || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname) || url.username || url.password) {
    throw new Error('飞书 Webhook 地址无效');
  }
  return url.href;
}

class Notifier {
  constructor({ getConfig, log, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
    if (typeof getConfig !== 'function') throw new TypeError('Notifier requires getConfig');
    if (typeof fetchImpl !== 'function') throw new TypeError('Notifier requires fetch');
    this.getConfig = getConfig;
    this.log = log;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.lastSent = new Map();
    this.pending = new Set();
    this.stats = { sent: 0, failures: 0, lastSentAt: null, lastTestAt: null, lastEvent: null, lastError: null };
  }

  _log(level, message) {
    if (typeof this.log?.[level] === 'function') this.log[level]('notify', message);
  }

  _config() { return this.getConfig() || {}; }

  _eventEnabled(config, key) {
    return Object.hasOwn(config.events || {}, key)
      ? config.events[key] === true
      : eventMap.get(key).defaultEnabled;
  }

  _cooldownMs(config) {
    const value = Number(config.cooldownSec ?? 1800);
    return Math.max(0, Number.isFinite(value) ? value : 1800) * 1000;
  }

  status() {
    const config = this._config();
    let configured = false;
    try { webhookUrl(config.webhook); configured = true; } catch {}
    return {
      enabled: config.enabled === true,
      configured,
      cooldownSec: this._cooldownMs(config) / 1000,
      events: Object.fromEntries(EVENTS.map(event => [event.key, this._eventEnabled(config, event.key)])),
      ...this.stats,
    };
  }

  async event(key, title, content) {
    if (!eventMap.has(key)) throw new Error(`未知通知事件：${key}`);
    const config = this._config();
    if (config.enabled !== true) return { sent: false, reason: 'disabled' };
    if (!this._eventEnabled(config, key)) return { sent: false, reason: 'event_disabled' };
    const previous = this.lastSent.get(key);
    if (previous != null && this.clock() - previous < this._cooldownMs(config)) return { sent: false, reason: 'cooldown' };
    if (this.pending.has(key)) return { sent: false, reason: 'in_flight' };
    this.pending.add(key);
    try {
      await this._send(config, title || eventMap.get(key).label, content || '', key);
      this.lastSent.set(key, this.clock());
      return { sent: true };
    } finally {
      this.pending.delete(key);
    }
  }

  async test() {
    const config = this._config();
    await this._send(config, 'TeleAgent 通知测试', '飞书通知通道连接成功。', 'test');
    this.stats.lastTestAt = this.stats.lastSentAt;
    return { sent: true };
  }

  async _send(config, title, content, key) {
    try {
      const url = webhookUrl(config.webhook);
      const body = { msg_type: 'text', content: { text: `${title}\n${content}` } };
      const secret = String(config.secret || '').trim();
      if (secret) {
        body.timestamp = String(Math.floor(this.clock() / 1000));
        // Feishu signs an empty message with timestamp + "\n" + secret as the HMAC key.
        // https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
        body.sign = crypto.createHmac('sha256', `${body.timestamp}\n${secret}`).digest('base64');
      }
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      let result;
      try { result = await response.json(); } catch { throw new Error(`飞书响应不是 JSON（HTTP ${response.status}）`); }
      const detail = errorText(result?.msg || result?.message || result?.StatusMessage || '');
      if (!response.ok) throw new Error(`飞书请求失败（HTTP ${response.status}）${detail ? '：' + detail : ''}`);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('飞书响应格式无效');
      const codes = [result.code, result.StatusCode].filter(code => code != null);
      if (!codes.length) throw new Error('飞书响应缺少结果代码');
      if (codes.some(code => !['0', 0].includes(code))) {
        throw new Error(`飞书拒绝通知（code ${codes.join('/')}）${detail ? '：' + detail : ''}`);
      }
      this.stats.sent++;
      this.stats.lastSentAt = new Date(this.clock()).toISOString();
      this.stats.lastEvent = key;
      this.stats.lastError = null;
      this._log('info', `通知已发送：${key}`);
    } catch (error) {
      const message = errorText(error);
      this.stats.failures++;
      this.stats.lastError = message;
      this._log('error', `通知发送失败：${message}`);
      throw new Error(message);
    }
  }
}

module.exports = { Notifier, EVENTS };
