'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  keepalive: { enabled: true, refreshSec: 300 },
  points: { enabled: true, claimTime: '08:05', catchupOnStart: true, pollMinutes: 10 },
  power: { restartPlan: { enabled: false, mode: 'daily', time: '04:30', weekday: 0 } },
  auth: { autoRelogin: true, reloginDays: 7, account: '', passwordEnc: '' },
  notify: { enabled: false, webhook: '', secret: '', cooldownSec: 1800, events: {
    keepalive_success: false, keepalive_failure: true, keepalive_recovered: false,
    instance_woke: false, signin_success: false, signin_failure: true,
    auth_expiring: false, auth_success: false, auth_failure: true,
    power_success: false, power_failure: true, service_failure: false,
  } },
};
function merge(base, patch) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.hasOwn(base, key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
      ? merge(base[key], value) : value;
  }
  return result;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`无法读取配置文件：${path.basename(file)}`); }
}
function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}
function integer(value, min, max, name) {
  if (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${name}需为 ${min}–${max} 的整数`);
  return Number(value);
}
function time(value) { if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('时间格式应为 HH:mm'); return value; }
function boolean(value, name) { if (typeof value !== 'boolean') throw new Error(`${name}需为开关值`); return value; }

class Store {
  constructor(dataDir, credentialsFile = path.join(dataDir, 'credentials.json')) {
    this.dataDir = dataDir;
    this.configFile = path.join(dataDir, 'config.json');
    this.credentialsFile = credentialsFile;
    this.config = merge(DEFAULTS, readJson(this.configFile, {}));
    this.state = readJson(path.join(dataDir, 'state.json'), {});
    this.credentials = readJson(credentialsFile, { operationToken: '', instanceId: '' });
    if (process.env.TELEAGENT_TOKEN) this.credentials.operationToken = process.env.TELEAGENT_TOKEN;
    if (process.env.TELEAGENT_INSTANCE_ID) this.credentials.instanceId = process.env.TELEAGENT_INSTANCE_ID;
    this.saveConfig();
  }
  saveConfig() { privateWrite(this.configFile, this.config); }
  saveState() { privateWrite(path.join(this.dataDir, 'state.json'), this.state); }
  setCredentials(value) { this.credentials = { operationToken: String(value.operationToken || ''), instanceId: String(value.instanceId || '') }; privateWrite(this.credentialsFile, this.credentials); }
  update(patch) {
    const next = structuredClone(this.config);
    for (const key of ['keepalive', 'points', 'power', 'auth', 'notify']) {
      if (patch[key] != null && (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key]))) throw new Error(`无效配置：${key}`);
    }
    if (patch.keepalive) {
      const p = patch.keepalive;
      if (p.enabled != null) next.keepalive.enabled = boolean(p.enabled, '保活开关');
      if (p.refreshSec != null) next.keepalive.refreshSec = integer(p.refreshSec, 60, 86400, '保活间隔');
    }
    if (patch.points) {
      const p = patch.points;
      for (const key of ['enabled', 'catchupOnStart']) if (p[key] != null) next.points[key] = boolean(p[key], key);
      if (p.claimTime != null) next.points.claimTime = time(p.claimTime);
      if (p.pollMinutes != null) next.points.pollMinutes = integer(p.pollMinutes, 2, 1440, '积分查询间隔');
    }
    if (patch.power?.restartPlan) {
      const p = patch.power.restartPlan;
      if (p.enabled != null) next.power.restartPlan.enabled = boolean(p.enabled, '重启计划开关');
      if (p.mode != null) { if (!['daily', 'weekly'].includes(p.mode)) throw new Error('无效的重启周期'); next.power.restartPlan.mode = p.mode; }
      if (p.time != null) next.power.restartPlan.time = time(p.time);
      if (p.weekday != null) next.power.restartPlan.weekday = integer(p.weekday, 0, 6, '星期');
    }
    if (patch.auth) {
      if (patch.auth.autoRelogin != null) next.auth.autoRelogin = boolean(patch.auth.autoRelogin, '自动续期开关');
      if (patch.auth.reloginDays != null) next.auth.reloginDays = integer(patch.auth.reloginDays, 1, 30, '提前续期天数');
    }
    if (patch.notify) {
      const p = patch.notify;
      if (p.enabled != null) next.notify.enabled = boolean(p.enabled, '通知开关');
      if (p.cooldownSec != null) next.notify.cooldownSec = integer(p.cooldownSec, 0, 86400, '通知冷却时间');
      if (p.webhook != null && String(p.webhook).trim()) {
        const webhook = String(p.webhook).trim();
        if (webhook.length > 2048) throw new Error('飞书 Webhook 过长');
        const token = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let url;
        try { url = new URL(webhook); } catch {}
        if (!token.test(webhook) && (!url || url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname) || url.username || url.password)) throw new Error('请填写飞书机器人的 Webhook 或 UUID');
        next.notify.webhook = webhook;
      }
      if (p.secret != null && String(p.secret).trim()) {
        const secret = String(p.secret).trim();
        if (secret.length > 256) throw new Error('飞书签名密钥过长');
        next.notify.secret = secret;
      }
      if (p.clearWebhook === true) next.notify.webhook = '';
      if (p.clearSecret === true) next.notify.secret = '';
      if (p.events) for (const [key, value] of Object.entries(p.events)) {
        if (!Object.hasOwn(DEFAULTS.notify.events, key)) throw new Error('未知通知事件');
        next.notify.events[key] = boolean(value, '事件开关');
      }
    }
    this.config = next;
    this.saveConfig();
    return this.publicConfig();
  }
  publicConfig() {
    const cfg = structuredClone(this.config);
    cfg.auth = { autoRelogin: cfg.auth.autoRelogin, reloginDays: cfg.auth.reloginDays };
    const { webhook, secret, ...notify } = cfg.notify;
    cfg.notify = { ...notify, hasWebhook: !!webhook, hasSecret: !!secret };
    return cfg;
  }
}
module.exports = { Store, DEFAULTS, privateWrite, readJson };
