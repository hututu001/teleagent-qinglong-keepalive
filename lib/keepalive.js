'use strict';

const READY_STATES = new Set([4, 100]);
const WAITING_STATES = new Set([1, 2, 5, 6]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const READY_WAIT_MS = 60000;

function safeError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[地址已隐藏]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[Token已隐藏]')
    .replace(/operationToken\s*[=:]\s*[^\s,;"}]+/gi, 'operationToken=[已隐藏]')
    .slice(0, 300);
}

function assertBusinessSuccess(result) {
  if (result?.code != null && ![0, 200].includes(Number(result.code))) throw new Error(`接口错误 ${result.code}`);
  if (result?.error?.code != null && Number(result.error.code) !== 0) throw new Error(`接口错误 ${result.error.code}`);
}

class KeepaliveService {
  constructor({ platform, getConfig, notify, log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    clock = () => Date.now(), setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout } = {}) {
    if (!platform || typeof getConfig !== 'function') throw new TypeError('KeepaliveService requires platform and getConfig');
    this.platform = platform;
    this.getConfig = getConfig;
    this.notify = notify;
    this.log = log;
    this.sleep = sleep;
    this.clock = clock;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.started = false;
    this.timer = null;
    this.runningPromise = null;
    this.deferUntil = 0;
    this.previouslyFailed = false;
    this.stats = {
      state: 'idle', lastRunAt: null, lastSuccessAt: null, lastStatus: null, lastStatusReason: null,
      runs: 0, failures: 0, wakes: 0, nextRunAt: null, lastError: null,
    };
  }

  _config() { return this.getConfig() || {}; }
  _enabled() { return this._config().enabled !== false; }
  _intervalMs() {
    const value = Number(this._config().refreshSec ?? 300);
    return Math.max(60, Number.isFinite(value) ? value : 300) * 1000;
  }
  _time() { return new Date(this.clock()).toISOString(); }
  _log(level, message) {
    if (typeof this.log?.[level] === 'function') this.log[level]('keepalive', message);
  }

  status() { return { enabled: this._enabled(), ...this.stats, running: this.runningPromise !== null }; }

  _clearTimer() {
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = null;
    this.stats.nextRunAt = null;
  }

  _schedule(delayMs) {
    this._clearTimer();
    if (!this.started || !this._enabled() || this.runningPromise) return;
    const delay = Math.max(0, delayMs, this.deferUntil - this.clock());
    this.stats.nextRunAt = new Date(this.clock() + delay).toISOString();
    if (this.deferUntil > this.clock()) this.stats.state = 'deferred';
    this.timer = this.schedule(() => {
      this.timer = null;
      this.stats.nextRunAt = null;
      if (!this.started || !this._enabled()) return;
      if (this.deferUntil > this.clock()) return this._schedule(0);
      return this.run('scheduled');
    }, delay);
    this.timer?.unref?.();
  }

  start() {
    const alreadyStarted = this.started;
    this.started = true;
    if (!this._enabled()) {
      this._clearTimer();
      if (!this.runningPromise) this.stats.state = 'disabled';
    } else if (!this.runningPromise) {
      this._schedule(alreadyStarted ? this._intervalMs() : 0);
    }
    return this.status();
  }

  stop() {
    this.started = false;
    this._clearTimer();
    if (!this.runningPromise) this.stats.state = this._enabled() ? 'idle' : 'disabled';
    return this.status();
  }

  defer(ms) {
    const value = Number(ms);
    this.deferUntil = Math.max(this.deferUntil, this.clock() + (Number.isFinite(value) ? Math.max(0, value) : 0));
    if (this.started && !this.runningPromise) this._schedule(0);
    return this.status();
  }

  run(source = 'manual') {
    if (this.runningPromise) return this.runningPromise;
    this._clearTimer();
    this.stats.state = 'running';
    this.stats.lastRunAt = this._time();
    this.stats.runs++;
    this.runningPromise = Promise.resolve().then(() => this._execute(String(source))).finally(() => {
      this.runningPromise = null;
      if (this.started) this._schedule(this._intervalMs());
    });
    return this.runningPromise;
  }

  async _notify(key, title, content) {
    try { await this.notify?.event(key, title, content); }
    catch (error) { this._log('warn', `通知失败，巡检结果保持不变：${safeError(error)}`); }
  }

  _checkTarget(context) {
    if (!context.instanceId) throw new Error('未配置目标实例 ID');
    if (String(this.platform.instanceId || '').trim() !== context.instanceId) throw new Error('目标实例已变更，本轮停止操作');
  }

  async _instance(context, timeoutMs = 20000) {
    this._checkTarget(context);
    const instance = await this.platform.instance({ timeoutMs });
    this._checkTarget(context);
    if (!instance || String(instance.id) !== context.instanceId) throw new Error('查询结果不是配置的目标实例');
    if (instance.status == null || !Number.isFinite(Number(instance.status))) throw new Error('实例状态无效');
    const result = { ...instance, status: Number(instance.status) };
    this.stats.lastStatus = result.status;
    this.stats.lastStatusReason = result.statusReason ?? null;
    return result;
  }

  async _waitReady(context, initialStatus) {
    const deadline = this.clock() + READY_WAIT_MS;
    let lastStatus = initialStatus;
    while (this.clock() < deadline) {
      await this.sleep(Math.min(10000, deadline - this.clock()));
      const remaining = deadline - this.clock();
      if (remaining <= 0) break;
      const instance = await this._instance(context, Math.min(20000, remaining));
      lastStatus = instance.status;
      this._log('info', `等待实例就绪：status=${lastStatus}`);
      if (READY_STATES.has(lastStatus)) return instance;
      if (![0, 3].includes(lastStatus) && !WAITING_STATES.has(lastStatus)) throw new Error(`实例状态 ${lastStatus} 暂未就绪`);
    }
    throw new Error(`等待就绪达到 60 秒，最后状态 ${lastStatus}`);
  }

  async _attempt(context) {
    let instance = await this._instance(context);
    this._log('info', `实例原始状态：status=${instance.status} statusReason=${instance.statusReason ?? 'unknown'}`);
    if ([0, 3].includes(instance.status)) {
      this._checkTarget(context);
      context.startRequested = true;
      assertBusinessSuccess(await this.platform.action('start'));
      instance = await this._waitReady(context, instance.status);
    } else if (WAITING_STATES.has(instance.status)) {
      instance = await this._waitReady(context, instance.status);
    } else if (!READY_STATES.has(instance.status)) {
      throw new Error(`实例状态 ${instance.status} 暂未就绪，未请求启动、刷新或连接`);
    }
    this._checkTarget(context);
    assertBusinessSuccess(await this.platform.request('/instance/refresh', {
      method: 'POST', body: { id: context.instanceId }, timeoutMs: 20000, allowEmpty: true,
    }));
    this._log('info', '活动刷新请求成功；防休眠效果观察中');
    this._checkTarget(context);
    const result = await this.platform.request('/instance/connect', {
      method: 'POST', body: { id: context.instanceId }, timeoutMs: 20000,
    });
    assertBusinessSuccess(result);
    if (typeof result?.data?.connectURL !== 'string' || !result.data.connectURL.trim()) throw new Error('connect 未返回有效连接地址');
    this._log('info', '桌面连接票据获取成功；长期在线待持续验证');
  }

  async _execute(source) {
    const context = { instanceId: String(this.platform.instanceId || '').trim(), startRequested: false };
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this._attempt(context);
        const recovered = this.previouslyFailed;
        this.previouslyFailed = false;
        this.stats.lastSuccessAt = this._time();
        this.stats.lastError = null;
        this.stats.state = 'success';
        if (context.startRequested) this.stats.wakes++;
        this._log('info', `第 ${attempt}/3 次尝试成功（${source}）`);
        if (context.startRequested) await this._notify('instance_woke', 'TeleAgent 云电脑已唤醒', '云电脑已恢复到可连接状态，活动刷新及取票成功。');
        if (recovered) await this._notify('keepalive_recovered', 'TeleAgent 保活已恢复', '上次巡检失败，本次活动刷新及取票成功。');
        await this._notify('keepalive_success', 'TeleAgent 保活巡检成功', `活动刷新及取票成功；本轮尝试 ${attempt}/3。`);
        return { ok: true, attempts: attempt, recovered, woke: context.startRequested, source };
      } catch (error) {
        lastError = safeError(error);
        this._log('warn', `第 ${attempt}/3 次尝试失败：${lastError}`);
        if (attempt < MAX_ATTEMPTS) await this.sleep(RETRY_DELAY_MS);
      }
    }
    this.previouslyFailed = true;
    this.stats.failures++;
    this.stats.state = 'error';
    this.stats.lastError = `连续 3 次尝试失败：${lastError}`;
    this._log('error', this.stats.lastError);
    await this._notify('keepalive_failure', 'TeleAgent 保活失败（重试已用尽）', this.stats.lastError);
    return { ok: false, attempts: MAX_ATTEMPTS, error: this.stats.lastError, source };
  }
}

module.exports = { KeepaliveService };
