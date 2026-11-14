'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const text = (id, value) => { const element = $(id); if (element) element.textContent = value == null || value === '' ? '—' : String(value); };
  const show = (id, visible) => { const element = $(id); if (element) element.hidden = !visible; };
  const errorText = (error) => error?.message || String(error || '操作未完成');
  const dateTime = (value, short = false) => {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(short ? {} : { month: '2-digit', day: '2-digit' }), hour: '2-digit', minute: '2-digit', ...(short ? { second: '2-digit' } : {}), hour12: false }).format(date);
  };
  const fullDate = (value) => {
    if (!value) return '未知';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : String(value);
  };
  const number = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN');
  const describe = (value) => {
    if (value == null) return '尚无执行记录';
    if (typeof value !== 'object') return String(value);
    return value.message || value.msg || value.error || value.result || (value.alreadyClaimed ? '今日已签到' : value.ok === true ? '执行成功' : value.ok === false ? '执行失败' : '已记录执行结果');
  };

  async function api(path, { method = 'GET', body, allowCaptcha = false } = {}) {
    const response = await fetch(path, { method, headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务返回了无法读取的结果（HTTP ${response.status}），请稍后重试。`); }
    if (response.status === 401 && path !== '/api/panel/login') {
      window.location.assign('/login');
      throw new Error('登录已过期，请重新登录工作台。');
    }
    if (allowCaptcha && data.captcha) return data;
    if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `请求失败（HTTP ${response.status}）`);
    return data;
  }
  const post = (path, body = {}, options = {}) => api(path, { method: 'POST', body, ...options });

  if (document.body.dataset.page === 'login') {
    $('panelLoginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type=submit]');
      show('loginError', false); button.disabled = true; button.textContent = '正在登录…';
      try {
        await post('/api/panel/login', { user: $('panelUser').value.trim(), password: $('panelPassword').value });
        window.location.assign('/');
      } catch (error) { text('loginError', errorText(error)); show('loginError', true); $('panelPassword').value = ''; }
      finally { button.disabled = false; button.textContent = '登录'; }
    });
    return;
  }

  let config = null, latestStatus = null, logs = [], refreshPromise = null, confirmation = null, captcha = null;
  const dirty = new Set();
  const titles = { overview: '运行概览', points: '每日签到', notifications: '飞书通知', account: '云电脑账号', power: '电源管理', logs: '活动日志' };
  const fallbackEvents = [
    { key: 'keepalive_success', label: '巡检成功', description: '正常完成一轮活动刷新和连接票据获取。', defaultEnabled: false },
    { key: 'keepalive_failure', label: '保活失败', description: '完整流程三次尝试均失败。', defaultEnabled: true },
    { key: 'keepalive_recovered', label: '保活恢复', description: '前一轮故障后，巡检重新成功。', defaultEnabled: false },
    { key: 'instance_woke', label: '云电脑唤醒成功', description: '发现休眠后，成功启动并恢复可连接状态。', defaultEnabled: false },
    { key: 'signin_success', label: '签到成功', description: '每日积分签到完成。', defaultEnabled: false },
    { key: 'signin_failure', label: '签到失败', description: '签到请求最终未成功。', defaultEnabled: true },
    { key: 'auth_expiring', label: '登录即将过期', description: '云账号凭据接近有效期。', defaultEnabled: false },
    { key: 'auth_success', label: '登录或续期成功', description: '云账号登录凭据已更新。', defaultEnabled: false },
    { key: 'auth_failure', label: '登录或续期失败', description: '云账号登录或自动续期发生错误。', defaultEnabled: true },
    { key: 'power_success', label: '电源操作成功', description: '重启、取消排队或重置请求已受理。', defaultEnabled: false },
    { key: 'power_failure', label: '电源操作失败', description: '手动操作或重启计划执行失败。', defaultEnabled: true },
    { key: 'service_failure', label: '平台服务异常', description: '平台服务状态查询失败。', defaultEnabled: false },
  ];

  function toast(message, isError = false) {
    const node = document.createElement('div'); node.className = 'toast' + (isError ? ' error' : ''); node.setAttribute('role', isError ? 'alert' : 'status'); node.textContent = message;
    $('toastRegion').append(node); window.setTimeout(() => node.remove(), isError ? 9000 : 5000);
  }
  function badge(id, label, tone) { const node = $(id); node.textContent = label; node.className = 'status-badge' + (tone ? ' ' + tone : ''); }
  function inlineError(id, value) { text(id, value); show(id, !!value); }
  function navigate(view) {
    if (!titles[view]) view = 'overview';
    document.querySelectorAll('.view').forEach((node) => { node.hidden = node.id !== 'view-' + view; });
    document.querySelectorAll('[data-view]').forEach((node) => { if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    text('pageTitle', titles[view]); document.title = titles[view] + ' · TeleAgent 工作台';
    const hash = '#' + view; if (window.location.hash !== hash) history.replaceState(null, '', hash);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  document.querySelectorAll('[data-view], [data-go-view]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.view || node.dataset.goView)));
  window.addEventListener('hashchange', () => navigate(window.location.hash.slice(1)));
  navigate(window.location.hash.slice(1));

  const settingsForms = ['keepaliveForm', 'pointsForm', 'notifyForm', 'authSettingsForm', 'powerForm'];
  function markDirty(id, changed = true) {
    if (changed) dirty.add(id); else dirty.delete(id);
    const hint = document.querySelector(`[data-dirty-for="${id}"]`); if (hint) hint.hidden = !changed;
  }
  settingsForms.forEach((id) => {
    $(id).addEventListener('input', () => markDirty(id));
    $(id).addEventListener('change', () => markDirty(id));
  });
  window.addEventListener('beforeunload', (event) => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
  const check = (id, value) => { $(id).checked = !!value; };
  const value = (id, input) => { $(id).value = input ?? ''; };
  function normalizedConfig(data) { return data.config || data; }
  function applyConfig(data) {
    const next = normalizedConfig(data);
    config = { ...(config || {}), ...next };
    if (data.notificationEvents) config.notificationEvents = data.notificationEvents;
    if (!dirty.has('keepaliveForm')) { check('keepaliveEnabled', config.keepalive?.enabled); value('refreshSec', config.keepalive?.refreshSec ?? 300); }
    if (!dirty.has('pointsForm')) { check('pointsEnabled', config.points?.enabled); value('claimTime', config.points?.claimTime || '08:05'); check('catchupOnStart', config.points?.catchupOnStart); value('pollMinutes', config.points?.pollMinutes ?? 10); }
    if (!dirty.has('authSettingsForm')) { check('autoRelogin', config.auth?.autoRelogin); value('reloginDays', config.auth?.reloginDays ?? 7); }
    if (!dirty.has('powerForm')) {
      const plan = config.power?.restartPlan || {}; check('restartPlanEnabled', plan.enabled); value('restartMode', plan.mode || 'daily'); value('restartTime', plan.time || '04:30'); value('restartWeekday', plan.weekday ?? 0); updateWeekday();
    }
    if (!dirty.has('notifyForm')) {
      const notify = config.notify || {}; check('notifyEnabled', notify.enabled); value('cooldownSec', notify.cooldownSec ?? 1800);
      value('feishuWebhook', ''); value('feishuSecret', ''); check('clearWebhook', false); check('clearSecret', false);
      text('webhookConfigured', notify.hasWebhook ? '已配置' : '未配置'); $('webhookConfigured').classList.toggle('configured', !!notify.hasWebhook);
      text('secretConfigured', notify.hasSecret ? '已配置' : '未配置'); $('secretConfigured').classList.toggle('configured', !!notify.hasSecret);
      renderEvents();
    }
  }
  function renderEvents() {
    const events = config.notificationEvents || fallbackEvents;
    const groups = new Map();
    events.forEach((event) => {
      const category = /^(keepalive|instance)_/.test(event.key) ? '云电脑巡检' : event.key.startsWith('signin_') ? '每日签到' : event.key.startsWith('auth_') ? '账号与登录' : event.key.startsWith('power_') ? '电源操作' : '平台服务';
      if (!groups.has(category)) groups.set(category, []); groups.get(category).push(event);
    });
    const host = $('notificationEvents'); host.replaceChildren();
    for (const [name, items] of groups) {
      const group = document.createElement('section'); group.className = 'event-group';
      const title = document.createElement('h4'); title.textContent = name; group.append(title);
      items.forEach((event) => {
        const label = document.createElement('label'); label.className = 'event-option';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.eventKey = event.key; input.checked = config.notify?.events?.[event.key] ?? !!event.defaultEnabled;
        const copy = document.createElement('span'); copy.append(document.createTextNode(event.label || event.key));
        const description = document.createElement('small'); description.textContent = event.description || ''; copy.append(description); label.append(input, copy); group.append(label);
      }); host.append(group);
    }
    updateEventCount();
  }
  function updateEventCount() { const all = $('notificationEvents').querySelectorAll('[data-event-key]'); const selected = Array.from(all).filter((input) => input.checked).length; text('eventCount', `已选择 ${selected} / ${all.length} 类事件，保存后生效。`); }
  $('notificationEvents').addEventListener('change', updateEventCount);
  document.querySelectorAll('[data-event-preset]').forEach((button) => button.addEventListener('click', () => {
    const mode = button.dataset.eventPreset; $('notificationEvents').querySelectorAll('[data-event-key]').forEach((input) => { input.checked = mode === 'all' || (mode === 'failures' && input.dataset.eventKey.endsWith('_failure')); }); updateEventCount(); markDirty('notifyForm');
  }));
  ['feishuWebhook', 'feishuSecret'].forEach((id) => $(id).addEventListener('input', () => { if ($(id).value.trim()) check(id === 'feishuWebhook' ? 'clearWebhook' : 'clearSecret', false); }));
  ['clearWebhook', 'clearSecret'].forEach((id) => $(id).addEventListener('change', () => { if ($(id).checked) value(id === 'clearWebhook' ? 'feishuWebhook' : 'feishuSecret', ''); }));
  function updateWeekday() { show('weekdayField', $('restartMode').value === 'weekly'); }
  $('restartMode').addEventListener('change', updateWeekday);

  async function withButton(button, action, loading = '处理中…') {
    if (button.disabled) return;
    const original = button.textContent; button.disabled = true; button.textContent = loading;
    try { return await action(); } finally { button.disabled = false; button.textContent = original; }
  }
  async function saveSettings(formId, patch, message) {
    const button = $(formId).querySelector('button[type=submit]');
    if (!config) { toast('配置尚未读取完成，请刷新状态后再保存。', true); return; }
    try {
      await withButton(button, async () => {
        const result = await post('/api/config', patch); markDirty(formId, false);
        if (result.config) applyConfig(result); else applyConfig({ ...config, ...patch });
        toast(message); await refreshStatus();
      }, '正在保存…');
    } catch (error) { toast(errorText(error), true); }
  }
  $('keepaliveForm').addEventListener('submit', (event) => { event.preventDefault(); saveSettings('keepaliveForm', { keepalive: { enabled: $('keepaliveEnabled').checked, refreshSec: Number($('refreshSec').value) } }, '巡检设置已保存。'); });
  $('pointsForm').addEventListener('submit', (event) => { event.preventDefault(); saveSettings('pointsForm', { points: { enabled: $('pointsEnabled').checked, claimTime: $('claimTime').value, catchupOnStart: $('catchupOnStart').checked, pollMinutes: Number($('pollMinutes').value) } }, '签到设置已保存。'); });
  $('authSettingsForm').addEventListener('submit', (event) => { event.preventDefault(); saveSettings('authSettingsForm', { auth: { autoRelogin: $('autoRelogin').checked, reloginDays: Number($('reloginDays').value) } }, '续期设置已保存。'); });
  $('powerForm').addEventListener('submit', (event) => { event.preventDefault(); saveSettings('powerForm', { power: { restartPlan: { enabled: $('restartPlanEnabled').checked, mode: $('restartMode').value, time: $('restartTime').value, weekday: Number($('restartWeekday').value) } } }, '重启计划已保存。'); });
  $('notifyForm').addEventListener('submit', (event) => {
    event.preventDefault(); const events = {}; $('notificationEvents').querySelectorAll('[data-event-key]').forEach((input) => { events[input.dataset.eventKey] = input.checked; });
    const notify = { enabled: $('notifyEnabled').checked, cooldownSec: Number($('cooldownSec').value), events };
    if ($('feishuWebhook').value.trim()) notify.webhook = $('feishuWebhook').value.trim();
    if ($('feishuSecret').value.trim()) notify.secret = $('feishuSecret').value.trim();
    if ($('clearWebhook').checked) notify.clearWebhook = true;
    if ($('clearSecret').checked) notify.clearSecret = true;
    saveSettings('notifyForm', { notify }, '飞书通知设置已保存。');
  });

  function renderStatus(status) {
    latestStatus = status; const ka = status.keepalive || {}, auth = status.auth || {}, points = status.points || {}, power = status.power || {}, system = status.system || {};
    let label = '等待巡检', tone = '', detail = '状态以最近一次巡检为准。';
    if (ka.enabled === false) { label = '巡检已暂停'; detail = '可点击“立即巡检”手动检查，或恢复自动巡检。'; }
    else if (ka.state === 'error' || ka.lastError) { label = '巡检异常'; tone = 'bad'; detail = ka.lastError || '最近一轮未成功，请查看活动日志。'; }
    else if (ka.running) { label = '正在巡检'; tone = 'warn'; detail = '正在查询状态、刷新活动和获取连接票据。'; }
    else if (ka.state === 'paused' || ka.state === 'deferred') { label = '等待系统就绪'; tone = 'warn'; detail = '电源操作后暂停自动启动，等待云电脑完成恢复。'; }
    else if ([4, 100].includes(Number(ka.lastStatus))) { label = '实例可连接'; tone = 'good'; detail = '最近一次巡检发现实例正常，活动刷新和取票结果见日志。'; }
    else if (Number(ka.lastStatus) === 3) { label = '实例已休眠'; tone = 'warn'; detail = '下一轮将按配置尝试启动，并确认是否恢复可连接状态。'; }
    else if ([1, 2, 5, 6].includes(Number(ka.lastStatus))) { label = '实例准备中'; tone = 'warn'; detail = '实例正在启动、排队或重启，等待就绪后继续。'; }
    badge('cloudBadge', label, tone); text('cloudDescription', detail); text('sideStatus', label); $('sideStatusDot').className = 'status-dot' + (tone === 'good' ? ' good' : tone === 'bad' || tone === 'warn' ? ' bad' : '');
    text('lastSuccess', dateTime(ka.lastSuccessAt)); text('nextCheck', ka.enabled === false ? '自动巡检已暂停' : dateTime(ka.nextRunAt)); text('runCount', number(ka.runs)); text('wakeCount', number(ka.wakes));
    text('toggleKeepalive', ka.enabled === false ? '恢复自动巡检' : '暂停巡检'); $('runKeepalive').disabled = !!ka.running;
    text('keepaliveDetail', ka.lastRunAt ? `最近执行 ${dateTime(ka.lastRunAt)} · 三次仍失败时按通知设置推送` : '完整流程最多尝试 3 次，相邻尝试间隔 5 秒。');
    text('overviewAuth', auth.ok ? auth.accountMasked || '已登录' : '待登录'); text('overviewExpiry', auth.expiresAt ? fullDate(auth.expiresAt) : '未知'); text('overviewBalance', number(points.balance)); text('overviewClaim', points.claiming ? '正在签到' : points.claimedToday ? '今日已完成' : points.lastError ? '最近执行失败' : '今日待签到');
    badge('accountBadge', auth.ok ? '云账号已登录' : '云账号待登录', auth.ok ? 'good' : 'warn'); text('accountName', auth.accountMasked || '云电脑账号');
    text('authDescription', auth.error || (auth.expiresAt ? `凭据有效期至 ${fullDate(auth.expiresAt)}${auth.daysLeft != null ? `，剩余约 ${auth.daysLeft} 天。` : '。'}` : '可以使用 Token 或手机号密码更新登录。'));
    $('relogin').disabled = !auth.hasPassword; text('savedPasswordState', auth.hasPassword ? '已保存账号密码，可以用于自动续期。' : '尚未保存账号密码；使用 Token 登录时，到期后需更新凭据。');
    text('pointsBalance', number(points.balance)); text('pointsPlan', points.plan || '套餐信息待读取');
    badge('claimBadge', points.claiming ? '签到执行中' : points.claimedToday ? '今日已签到' : points.lastError ? '签到待检查' : '今日待签到', points.claiming ? 'warn' : points.claimedToday ? 'good' : points.lastError ? 'bad' : '');
    text('claimDescription', points.claiming ? '正在向平台领取每日登录积分。' : points.claimedToday ? `最近签到：${dateTime(points.lastClaimAt)}` : points.enabled === false ? '自动签到已关闭，仍可手动执行。' : `自动签到时间：${points.claimTime || config?.points?.claimTime || '08:05'}，按北京时间执行。`);
    $('claimPoints').disabled = !!points.claiming; text('nextClaim', points.enabled === false ? '自动签到已关闭' : dateTime(points.nextClaimAt)); text('lastClaimAt', dateTime(points.lastClaimAt)); text('lastClaimResult', describe(points.lastResult)); text('pointsUpdatedAt', dateTime(points.updatedAt)); inlineError('pointsError', points.lastError || points.error);
    text('nextRestart', power.restartPlan?.enabled ? dateTime(power.nextRestartAt) : '定时重启已关闭'); text('lastPowerResult', describe(power.lastResult)); inlineError('powerError', power.lastError);
    text('hostPlatform', system.platform || '运行环境待读取'); text('hostNode', system.node);
    const seconds = Number(system.uptime || 0); text('hostUptime', seconds > 0 ? `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds / 3600) % 24} 小时 ${Math.floor(seconds / 60) % 60} 分钟` : '—');
    const memory = system.memory || {}; const percent = Number(memory.percent ?? (memory.total ? memory.used / memory.total * 100 : NaN));
    text('hostMemory', Number.isFinite(percent) ? `${percent.toFixed(1)}%${memory.total ? ` / ${(memory.total / 1073741824).toFixed(1)} GB` : ''}` : '—'); $('memoryMeter').style.width = `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0}%`;
    const cpu = system.cpu || {}; text('hostCpu', cpu.count ? `${cpu.count} 核${Number.isFinite(Number(cpu.percent)) ? ` / ${Number(cpu.percent).toFixed(1)}%` : Array.isArray(cpu.load) ? ` / 负载 ${Number(cpu.load[0]).toFixed(2)}` : ''}` : '—');
    const service = status.service; if (service) renderService(service);
    text('syncStatus', `同步于 ${dateTime(status.time || Date.now(), true)}`); text('footerUpdated', '状态以最近一次巡检为准 · 北京时间');
  }
  function renderService(result) {
    const message = result.error || result.message || result.msg || (result.ok === false ? '查询失败' : result.data?.message || '平台服务查询成功');
    text('serviceStatus', `${message}${result.updatedAt || result.at ? ' · ' + dateTime(result.updatedAt || result.at) : ''}`);
  }
  async function refreshStatus() { const result = await api('/api/status'); renderStatus(result); return result; }
  function logParts(entry) { return { time: entry.time || entry.at || entry.timestamp, level: String(entry.level || 'info').toLowerCase(), scope: entry.scope || entry.module || '系统', message: entry.message || entry.msg || '' }; }
  function renderLogs() {
    const entries = logs.slice().reverse().map(logParts);
    $('recentLogs').replaceChildren();
    if (!entries.length) $('recentLogs').append(empty('还没有活动记录。完成首次巡检后，记录会显示在这里。'));
    entries.slice(0, 6).forEach((entry) => {
      const row = document.createElement('div'); row.className = 'activity-item'; const time = document.createElement('time'); time.textContent = dateTime(entry.time, true); const level = levelTag(entry.level); const message = document.createElement('p'); message.textContent = `${entry.scope}：${entry.message}`; row.append(time, level, message); $('recentLogs').append(row);
    });
    const level = $('logLevel').value, query = $('logSearch').value.trim().toLocaleLowerCase();
    const visible = entries.filter((entry) => (level === 'all' || entry.level === level || (level === 'warn' && entry.level === 'warning')) && (!query || `${entry.scope} ${entry.message}`.toLocaleLowerCase().includes(query)));
    text('logCount', `${visible.length} 条记录`); $('logRows').replaceChildren();
    if (!visible.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.className = 'empty-state'; cell.textContent = entries.length ? '没有匹配的日志，请调整筛选条件。' : '暂无日志。'; row.append(cell); $('logRows').append(row); }
    visible.forEach((entry) => { const row = document.createElement('tr'); const time = document.createElement('td'); time.textContent = dateTime(entry.time); const levelCell = document.createElement('td'); levelCell.append(levelTag(entry.level)); const scope = document.createElement('td'); scope.textContent = entry.scope; const message = document.createElement('td'); message.textContent = entry.message; row.append(time, levelCell, scope, message); $('logRows').append(row); });
  }
  function empty(message) { const node = document.createElement('p'); node.className = 'empty-state'; node.textContent = message; return node; }
  function levelTag(level) { const span = document.createElement('span'); const normal = level === 'warning' ? 'warn' : level; span.className = 'log-level ' + (['warn', 'error', 'info'].includes(normal) ? normal : 'info'); span.textContent = { info: '信息', warn: '提醒', error: '错误', debug: '调试' }[normal] || level; return span; }
  async function refreshLogs() { const result = await api('/api/logs'); logs = Array.isArray(result) ? result : result.logs || []; renderLogs(); }
  async function refreshAll() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        if (!config) applyConfig(await api('/api/config'));
        const results = await Promise.allSettled([refreshStatus(), refreshLogs()]);
        const failure = results.find((result) => result.status === 'rejected'); if (failure) throw failure.reason;
        show('connectionBanner', false);
      } catch (error) { text('connectionBanner', `工作台状态同步失败：${errorText(error)} 页面保留上次读取的结果，将自动重试。`); show('connectionBanner', true); text('syncStatus', '连接待恢复'); }
      finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  ['logLevel', 'logSearch'].forEach((id) => $(id).addEventListener('input', renderLogs));
  $('refreshAll').addEventListener('click', () => withButton($('refreshAll'), refreshAll, '正在刷新…'));
  $('refreshLogs').addEventListener('click', () => perform('refreshLogs', async () => { await refreshLogs(); toast('日志已刷新。'); }));
  async function perform(id, action) { try { await withButton($(id), action); } catch (error) { toast(errorText(error), true); } }
  async function action(id, path, message, body = {}) { return perform(id, async () => { const result = await post(path, body); toast(result.message || message); await refreshAll(); return result; }); }
  $('runKeepalive').addEventListener('click', () => action('runKeepalive', '/api/keepalive/run', '本轮巡检已完成。'));
  $('toggleKeepalive').addEventListener('click', () => {
    const enabled = latestStatus?.keepalive?.enabled === false;
    perform('toggleKeepalive', async () => { await post('/api/keepalive/toggle', { enabled }); if (config) config.keepalive = { ...config.keepalive, enabled }; if (!dirty.has('keepaliveForm')) check('keepaliveEnabled', enabled); toast(enabled ? '自动巡检已恢复。' : '自动巡检已暂停。'); await refreshAll(); });
  });
  $('refreshPoints').addEventListener('click', () => action('refreshPoints', '/api/points/refresh', '积分状态已刷新。'));
  $('claimPoints').addEventListener('click', () => action('claimPoints', '/api/points/claim', '签到执行完成。'));
  $('relogin').addEventListener('click', () => action('relogin', '/api/auth/relogin', '登录凭据已续期。'));
  $('testNotify').addEventListener('click', () => {
    if (dirty.has('notifyForm')) { toast('请先保存通知设置，再发送测试通知。', true); return; }
    action('testNotify', '/api/notify/test', '测试通知已发送，请在飞书查看。');
  });
  $('refreshService').addEventListener('click', () => perform('refreshService', async () => { const result = await post('/api/service/refresh'); renderService(result); toast('平台服务状态已刷新。'); }));
  $('openDesktop').addEventListener('click', () => {
    const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
    perform('openDesktop', async () => {
      try {
        const result = await post('/api/desktop/open');
        const url = new URL(result.url); if (url.protocol !== 'https:') throw new Error('平台返回了无效的云电脑连接地址。');
        if (popup) popup.location.replace(url.href); else toast('浏览器拦截了新窗口，请允许弹出窗口后再点击“打开云电脑”。', true);
      } catch (error) { if (popup) popup.close(); throw error; }
    });
  });

  function confirmAction(options) {
    confirmation = options; text('confirmTitle', options.title); text('confirmDescription', options.description); text('confirmRequired', options.required || ''); show('confirmWordLabel', !!options.required); value('confirmWord', ''); show('confirmError', false); $('confirmWord').required = !!options.required; $('confirmDialog').showModal(); if (options.required) $('confirmWord').focus();
  }
  ['closeConfirm', 'cancelConfirm'].forEach((id) => $(id).addEventListener('click', () => $('confirmDialog').close()));
  $('confirmForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const pending = confirmation; if (!pending) return;
    if (pending.required && $('confirmWord').value.trim() !== pending.required) { inlineError('confirmError', `请输入 ${pending.required} 后再执行。`); return; }
    try { await withButton($('confirmSubmit'), async () => { await post(pending.path, pending.body || { confirmation: pending.required }); $('confirmDialog').close(); toast(pending.success); if (pending.after) await pending.after(); await refreshAll(); }); }
    catch (error) { inlineError('confirmError', errorText(error)); }
  });
  $('restartDesktop').addEventListener('click', () => confirmAction({ title: '重启云电脑', description: '这会中断云电脑当前的会话和正在运行的工作。请先保存文件。', required: 'RESTART', path: '/api/power/restart', success: '云电脑重启请求已发送。' }));
  $('cancelQueue').addEventListener('click', () => confirmAction({ title: '取消当前排队', description: '取消后需要重新发起连接请求。', path: '/api/power/cancel', body: {}, success: '取消排队请求已发送。' }));
  $('rebuildDesktop').addEventListener('click', () => confirmAction({ title: '重置云电脑服务', description: '重置可能清除系统盘安装的软件和数据，并中断当前工作。请先确认需要保留的文件已经备份。\n只有输入 RESET 后才会发送重置请求。', required: 'RESET', path: '/api/power/rebuild', success: '云电脑重置请求已发送。' }));
  $('cloudLogout').addEventListener('click', () => confirmAction({ title: '清除云账号登录', description: '清除后，巡检、签到和云电脑管理需要重新配置登录凭据。工作台登录不受影响。', required: 'LOGOUT', path: '/api/auth/logout', success: '云账号登录凭据已清除。' }));
  $('panelLogout').addEventListener('click', () => {
    if (dirty.size) { toast('有未保存的设置，请先保存或刷新页面放弃修改，再退出。', true); return; }
    perform('panelLogout', async () => { await post('/api/panel/logout'); window.location.assign('/login'); });
  });

  $('tokenForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button');
    try { await withButton(button, async () => { await post('/api/auth/token', { operationToken: $('operationToken').value.trim(), instanceId: $('instanceId').value.trim() }); value('operationToken', ''); toast('云账号凭据已保存。'); await refreshAll(); }, '正在保存…'); }
    catch (error) { toast(errorText(error), true); }
  });
  function imageSource(base64) { return String(base64 || '').startsWith('data:image/') ? String(base64) : 'data:image/png;base64,' + String(base64 || ''); }
  function showCaptcha(challenge) {
    captcha = challenge; value('captchaOffset', 0); text('captchaOffsetValue', '0'); $('captchaOffset').max = Number(challenge.width) || 310;
    $('captchaOriginal').src = imageSource(challenge.originalImageBase64); $('captchaPiece').src = imageSource(challenge.jigsawImageBase64); show('captchaPanel', true); show('refreshCaptcha', true); text('accountLoginSubmit', '完成验证并登录');
  }
  $('captchaOriginal').addEventListener('load', () => { const width = $('captchaOriginal').naturalWidth || 310; const pieceWidth = $('captchaPiece').naturalWidth || 0; $('captchaOffset').max = Math.max(1, width - pieceWidth); updateCaptchaPosition(); });
  $('captchaPiece').addEventListener('load', () => { const width = $('captchaOriginal').naturalWidth || 310; $('captchaOffset').max = Math.max(1, width - ($('captchaPiece').naturalWidth || 0)); updateCaptchaPosition(); });
  function updateCaptchaPosition() { const width = $('captchaOriginal').naturalWidth || 310; const offset = Number($('captchaOffset').value); $('captchaPiece').style.left = `${offset / width * 100}%`; text('captchaOffsetValue', `${offset} 像素`); }
  $('captchaOffset').addEventListener('input', updateCaptchaPosition);
  async function loginCloud(fresh = false) {
    if (fresh) captcha = null;
    const payload = { account: $('cloudAccount').value.trim(), password: $('cloudPassword').value, remember: $('rememberAccount').checked };
    if (captcha) { payload.captchaId = captcha.id; payload.offset = Number($('captchaOffset').value); }
    const result = await post('/api/auth/login', payload, { allowCaptcha: true });
    if (result.captcha) { showCaptcha(result.captcha); toast('需要完成图片验证，请对齐滑块后继续。'); return; }
    captcha = null; show('captchaPanel', false); show('refreshCaptcha', false); value('cloudPassword', ''); text('accountLoginSubmit', '登录并保存凭据'); toast('云账号登录成功。'); await refreshAll();
  }
  $('accountLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('accountLoginSubmit');
    try { await withButton(button, () => loginCloud(), '正在登录…'); }
    catch (error) { toast(errorText(error), true); }
    finally { text('accountLoginSubmit', captcha ? '完成验证并登录' : '登录并保存凭据'); }
  });
  $('refreshCaptcha').addEventListener('click', () => perform('refreshCaptcha', () => loginCloud(true)));

  async function poll() { await refreshAll(); window.setTimeout(poll, document.hidden ? 30000 : 10000); }
  window.addEventListener('focus', () => { refreshAll(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  poll();
})();
