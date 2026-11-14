'use strict';

const CENTER = '/user/portal/companyStore/userCenter';
const DAY_TASK = '/user/portal/companyStore/v3/checkDayTask?theme=light';
const CLAIM = '/user/portal/companyStore/checkTask?type=daily_login';
const CHINA_OFFSET = 8 * 60 * 60 * 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function dateInChina(ms) {
  return new Date(ms + CHINA_OFFSET).toISOString().slice(0, 10);
}

function scheduledTime(date, time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('签到时间必须为 HH:mm');
  return Date.parse(`${date}T${time}:00+08:00`);
}

function validResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('积分接口响应无效');
  if (response.code != null && ![0, 200].includes(Number(response.code))) throw new Error(`积分接口返回错误码 ${response.code}`);
  if (response.error?.code != null && Number(response.error.code) !== 0) throw new Error(`积分接口返回错误码 ${response.error.code}`);
  return response;
}

function taskState(response) {
  const data = validResponse(response).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('每日任务数据缺失');
  const activity = Array.isArray(data.activity_data) ? data.activity_data.find(item => {
    const url = String(item?.jump_url || '');
    return url.includes('checkTask') && /[?&]type=daily_login(?:&|$)/.test(url);
  }) : null;
  const daily = data.daily_task;
  const dailyKnown = daily && typeof daily.claimed_today === 'boolean';
  if (!dailyKnown && (!activity || typeof activity.action_status !== 'string')) throw new Error('每日登录签到状态缺失');
  return { task: data, claimed: !!(dailyKnown && daily.claimed_today) || activity?.action_status === 'completed' };
}

class PointsService {
  constructor({ platform, getConfig, notify, log, state = {}, saveState = () => {},
    now = () => Date.now(), sleep = pause, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    this.platform = platform;
    this.getConfig = getConfig;
    this.notify = notify || { event: async () => {} };
    this.log = log || { info() {}, warn() {}, error() {} };
    this.state = state;
    this.saveState = saveState;
    this.now = now;
    this.sleep = sleep;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.running = false;
    this.claiming = false;
    this.ticking = false;
    this.timer = null;
    this.nextRefreshAt = 0;
  }

  settings() {
    const config = this.getConfig?.() || {};
    const minutes = Number(config.pollMinutes ?? 10);
    return {
      enabled: config.enabled !== false,
      claimTime: config.claimTime || '08:05',
      catchupOnStart: config.catchupOnStart !== false,
      pollMinutes: Number.isFinite(minutes) ? Math.max(2, minutes) : 10,
    };
  }

  status() {
    const config = this.settings();
    const today = dateInChina(this.now());
    let nextClaimAt = null;
    try {
      let next = scheduledTime(today, config.claimTime);
      if (next <= this.now() || this.state.lastClaimDate === today || this.state.lastScheduledDate === today) next += 86400000;
      if (config.enabled) nextClaimAt = new Date(next).toISOString();
    } catch {}
    return {
      ...config, running: this.running, claiming: this.claiming,
      balance: this.state.balance ?? null, plan: this.state.plan ?? null,
      task: this.state.task ?? null, updatedAt: this.state.updatedAt || null,
      claimedToday: this.state.lastClaimDate === today,
      nextClaimAt, lastClaimDate: this.state.lastClaimDate || null,
      lastClaimAt: this.state.lastClaimAt || null,
      lastResult: this.state.lastResult || null, lastError: this.state.lastError || null,
    };
  }

  async retry(operation) {
    let error;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await operation(); } catch (caught) {
        error = caught;
        this.log.warn('Points', `第 ${attempt}/3 次尝试失败：${caught.message}`);
        if (attempt < 3) await this.sleep(5000);
      }
    }
    throw error;
  }

  async readCenter() {
    const response = validResponse(await this.platform.request(CENTER, { base: 'points' }));
    const data = response.data;
    if (!data || typeof data !== 'object' || data.current_points_balance == null || !Number.isFinite(Number(data.current_points_balance))) {
      throw new Error('积分余额数据缺失');
    }
    this.state.balance = Number(data.current_points_balance);
    this.state.plan = data.plan_display_name || null;
  }

  async readTask() {
    const result = taskState(await this.platform.request(DAY_TASK, { base: 'points' }));
    this.state.task = result.task;
    if (result.claimed) this.state.lastClaimDate = dateInChina(this.now());
    return result;
  }

  async refresh() {
    try {
      await this.retry(async () => {
        await this.readCenter();
        await this.readTask();
      });
      this.state.updatedAt = new Date(this.now()).toISOString();
      this.state.lastError = null;
      await this.saveState();
      return { ok: true, ...this.status() };
    } catch (error) {
      this.state.lastError = error.message;
      await this.saveState();
      this.log.error('Points', `积分查询失败：${error.message}`);
      return { ok: false, error: error.message, ...this.status() };
    }
  }

  async notifyEvent(key, title, content) {
    try { await this.notify.event(key, title, content); } catch (error) {
      this.log.warn('Points', `通知调用失败：${error.message}`);
    }
  }

  async claim(source = 'manual') {
    if (this.claiming) return { ok: false, status: 'busy', source, error: '签到任务正在执行' };
    let today = dateInChina(this.now());
    if (this.state.lastClaimDate === today) return { ok: true, status: 'already_claimed', source, date: today, balance: this.state.balance ?? null };
    this.claiming = true;
    let result;
    try {
      const status = await this.retry(async () => {
        // Always recheck the task before retrying a request whose response may
        // have been lost after the server accepted it.
        if ((await this.readTask()).claimed) return 'already_claimed';
        const response = validResponse(await this.platform.request(CLAIM, { base: 'points' }));
        if (response.code == null && response.error?.code == null) throw new Error('签到接口缺少明确的成功状态');
        return 'claimed';
      });
      today = dateInChina(this.now());
      this.state.lastClaimDate = today;
      this.state.lastClaimAt = new Date(this.now()).toISOString();
      this.state.lastError = null;
      result = { ok: true, status, source, date: today, at: this.state.lastClaimAt };
      // A balance read failure does not undo an already accepted sign-in.
      try { await this.retry(() => this.readCenter()); } catch (error) {
        this.log.warn('Points', `签到已确认，余额刷新失败：${error.message}`);
        result.balanceError = error.message;
      }
      result.balance = this.state.balance ?? null;
      this.state.lastResult = result;
      await this.saveState();
      this.log.info('Points', status === 'claimed' ? '每日登录签到已受理' : '今日已签到，跳过重复领取');
      if (status === 'claimed') await this.notifyEvent('signin_success', 'TeleAgent 签到成功', `日期：${today}\n余额：${result.balance ?? '未知'}\n来源：${source}`);
      return result;
    } catch (error) {
      result = { ok: false, status: 'error', source, date: today, at: new Date(this.now()).toISOString(), error: error.message };
      this.state.lastError = error.message;
      this.state.lastResult = result;
      await this.saveState();
      this.log.error('Points', `签到失败：${error.message}`);
      await this.notifyEvent('signin_failure', 'TeleAgent 签到失败', `日期：${today}\n原因：${error.message}\n来源：${source}`);
      return result;
    } finally { this.claiming = false; }
  }

  async tick(startup = false) {
    if (this.ticking || !this.running) return;
    this.ticking = true;
    try {
      const config = this.settings();
      if (!config.enabled) return;
      const now = this.now();
      const today = dateInChina(now);
      if (now >= this.nextRefreshAt) {
        this.nextRefreshAt = now + config.pollMinutes * 60000;
        await this.refresh();
      }
      if (!this.running || this.state.lastClaimDate === today) return;
      const due = now >= scheduledTime(today, config.claimTime);
      const catchup = startup && due && config.catchupOnStart;
      if (startup && due && !config.catchupOnStart && this.state.lastScheduledDate !== today) {
        this.state.lastScheduledDate = today;
        await this.saveState();
        return;
      }
      if ((due || catchup) && this.state.lastScheduledDate !== today) {
        this.state.lastScheduledDate = today;
        await this.saveState();
        await this.claim(catchup ? 'catchup' : 'scheduled');
      }
    } catch (error) {
      this.log.error('Points', `签到调度失败：${error.message}`);
    } finally { this.ticking = false; }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.nextRefreshAt = 0;
    this.timer = this.setIntervalFn(() => { this.tick().catch(error => this.log.error('Points', error.message)); }, 30000);
    this.timer?.unref?.();
    return this.tick(true);
  }

  stop() {
    this.running = false;
    if (this.timer != null) this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

module.exports = { PointsService };
