'use strict';

const CHINA_OFFSET = 8 * 60 * 60 * 1000;
const DAY_MS = 86400000;

function chinaDate(ms) { return new Date(ms + CHINA_OFFSET).toISOString().slice(0, 10); }
function slotFor(date, time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('重启计划时间必须为 HH:mm');
  return Date.parse(`${date}T${time}:00+08:00`);
}
function weekday(ms) { return new Date(ms + CHINA_OFFSET).getUTCDay(); }

class PowerService {
  constructor({ platform, getConfig, notify, log, state = {}, saveState = () => {}, busy = () => false,
    defer = () => {}, now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    this.platform = platform;
    this.getConfig = getConfig;
    this.notify = notify || { event: async () => {} };
    this.log = log || { info() {}, warn() {}, error() {} };
    this.state = state;
    this.saveState = saveState;
    this.busy = busy;
    this.defer = defer;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.running = false;
    this.executing = false;
    this.ticking = false;
    this.timer = null;
    this.planKey = null;
    this.plannedAt = null;
  }

  plan() {
    const input = (this.getConfig?.() || {}).restartPlan || {};
    return { enabled: input.enabled === true, mode: input.mode || 'daily', time: input.time || '04:30', weekday: Number(input.weekday ?? 0) };
  }

  nextTime() {
    const plan = this.plan();
    if (!plan.enabled) return null;
    if (!['daily', 'weekly'].includes(plan.mode) || !Number.isInteger(plan.weekday) || plan.weekday < 0 || plan.weekday > 6) return null;
    try {
      const start = slotFor(chinaDate(this.now()), plan.time);
      for (let day = 0; day < 8; day++) {
        const at = start + day * DAY_MS;
        if (at <= this.now() || this.state.lastPlanDate === chinaDate(at)) continue;
        if (plan.mode === 'daily' || weekday(at) === plan.weekday) return new Date(at).toISOString();
      }
    } catch {}
    return null;
  }

  status() {
    const planned = this.planKey === JSON.stringify(this.plan()) && this.plannedAt != null ? new Date(this.plannedAt).toISOString() : this.nextTime();
    return { running: this.running, executing: this.executing, restartPlan: this.plan(), nextRestartAt: planned,
      lastPlanDate: this.state.lastPlanDate || null, lastResult: this.state.lastResult || null, lastError: this.state.lastError || null };
  }

  async notifyEvent(key, title, content) {
    try { await this.notify.event(key, title, content); } catch (error) {
      this.log.warn('Power', `通知调用失败：${error.message}`);
    }
  }

  async execute(action, confirmation, { source = 'manual' } = {}) {
    if (!['restart', 'cancel', 'rebuild'].includes(action)) return { ok: false, action, source, error: '不支持的电源操作' };
    if (action === 'rebuild' && confirmation !== 'RESET') return { ok: false, action, source, error: '重置必须确认 RESET' };
    if (this.executing) return { ok: false, action, source, error: '电源操作正在执行' };
    this.executing = true;
    try {
      if (action === 'restart') await this.defer(180000);
      if (action === 'rebuild') await this.defer(300000);
      const response = await this.platform.action(action);
      if (response?.code != null && ![0, 200].includes(Number(response.code))) throw new Error(`电源接口返回错误码 ${response.code}`);
      if (response?.error?.code != null && Number(response.error.code) !== 0) throw new Error(`电源接口返回错误码 ${response.error.code}`);
      const result = { ok: true, action, source, at: new Date(this.now()).toISOString(), status: 'accepted' };
      this.state.lastResult = result;
      this.state.lastError = null;
      await this.saveState();
      this.log.info('Power', `${action} 请求已受理（${source}）`);
      await this.notifyEvent('power_success', 'TeleAgent 电源操作已受理', `操作：${action}\n来源：${source}\n时间：${result.at}`);
      return result;
    } catch (error) {
      const result = { ok: false, action, source, at: new Date(this.now()).toISOString(), error: error.message };
      this.state.lastResult = result;
      this.state.lastError = error.message;
      await this.saveState();
      this.log.error('Power', `${action} 请求失败：${error.message}`);
      await this.notifyEvent('power_failure', 'TeleAgent 电源操作失败', `操作：${action}\n来源：${source}\n原因：${error.message}`);
      return result;
    } finally { this.executing = false; }
  }

  async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      const plan = this.plan();
      const key = JSON.stringify(plan);
      if (!plan.enabled) { this.planKey = key; this.plannedAt = null; return; }
      if (!['daily', 'weekly'].includes(plan.mode) || !Number.isInteger(plan.weekday) || plan.weekday < 0 || plan.weekday > 6) throw new Error('重启计划周期无效');
      const now = this.now();
      if (this.planKey !== key) {
        this.planKey = key;
        const next = this.nextTime();
        this.plannedAt = next ? Date.parse(next) : null;
        return;
      }
      if (this.plannedAt == null || now < this.plannedAt) return;
      const today = chinaDate(this.plannedAt);
      const next = this.nextTime();
      this.plannedAt = next ? Date.parse(next) : null;
      if (this.state.lastPlanDate === today) return;
      // Persist the occurrence before sending a power request. A lost response
      // or process restart must not send a second restart for the same date.
      this.state.lastPlanDate = today;
      await this.saveState();
      if (this.busy() || this.executing) {
        this.state.lastResult = { ok: true, status: 'skipped_busy', action: 'restart', source: 'scheduled', at: new Date(now).toISOString() };
        await this.saveState();
        this.log.warn('Power', '重启计划已跳过：任务正在执行');
        return;
      }
      await this.execute('restart', undefined, { source: 'scheduled' });
    } catch (error) {
      this.log.error('Power', `重启计划执行失败：${error.message}`);
    } finally { this.ticking = false; }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = this.setIntervalFn(() => { this.tick().catch(error => this.log.error('Power', error.message)); }, 30000);
    this.timer?.unref?.();
    return this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer != null) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.planKey = null;
    this.plannedAt = null;
  }
}

module.exports = { PowerService };
