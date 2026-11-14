'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AccountService } = require('./lib/account');
const { KeepaliveService } = require('./lib/keepalive');
const { Logger, redact } = require('./lib/log');
const { Notifier, EVENTS } = require('./lib/notify');
const { PanelAuth } = require('./lib/panel-auth');
const { PlatformClient } = require('./lib/platform');
const { PointsService } = require('./lib/points');
const { PowerService } = require('./lib/power');
const { Store } = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const SAFE_SERVICE_FIELDS = ['id', 'name', 'displayName', 'region', 'status', 'statusReason'];

function json(res, status, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function page(res, status, file, extraHeaders = {}) {
  const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function safeError(error) {
  return redact(error?.message || error || '操作失败')
    .replace(/(password|passwd|secret|webhook|operationToken)\s*[=:]\s*[^\s,;"}]+/gi, '$1=[已隐藏]')
    .slice(0, 500);
}

async function readBody(req, maxBytes = 128 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('请求必须使用 JSON 格式'), { statusCode: 415 });
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('请求 JSON 格式无效'), { statusCode: 400 });
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  try { return !!host && new URL(origin).host.toLowerCase() === host; } catch { return false; }
}

function systemStatus() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    uptime: Math.floor(os.uptime()),
    memory: { total, used: total - free, percent: total ? (total - free) / total * 100 : null },
    cpu: { count: os.cpus().length, percent: null, load: os.loadavg() },
  };
}

function createApplication({
  dataDir = process.env.TA_DATA_DIR || path.join(__dirname, 'data'),
  credentialsFile = process.env.TA_CREDENTIALS_FILE,
  env = process.env,
  fetchImpl = globalThis.fetch,
  loginService,
  clock = () => Date.now(),
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch {}
  const store = new Store(dataDir, credentialsFile || path.join(dataDir, 'credentials.json'));
  const logger = new Logger(dataDir);
  const panelAuth = new PanelAuth(dataDir, { user: env.TA_PANEL_USER || 'admin', password: env.TA_PANEL_PASSWORD });
  const platform = new PlatformClient({ getCredentials: () => store.credentials, fetchImpl });
  const notifier = new Notifier({ getConfig: () => store.config.notify, log: logger, fetchImpl, clock });
  const keepalive = new KeepaliveService({ platform, getConfig: () => store.config.keepalive, notify: notifier, log: logger, clock });
  const pointsState = store.state.points && typeof store.state.points === 'object' ? store.state.points : (store.state.points = {});
  const powerState = store.state.power && typeof store.state.power === 'object' ? store.state.power : (store.state.power = {});
  const points = new PointsService({ platform, getConfig: () => store.config.points, notify: notifier, log: logger, state: pointsState, saveState: () => store.saveState() });
  const power = new PowerService({
    platform, getConfig: () => store.config.power, notify: notifier, log: logger, state: powerState,
    saveState: () => store.saveState(), busy: () => keepalive.status().running || points.status().claiming,
    defer: ms => keepalive.defer(ms), now: clock,
  });
  let serviceStatus = null;
  const account = new AccountService({
    store, platform, notify: notifier, log: logger, login: loginService,
    onChange: async () => { syncBackground(); },
  });

  function syncBackground() {
    const configured = !!store.credentials.operationToken;
    if (!configured) {
      keepalive.stop(); points.stop(); power.stop(); account.stop();
      return;
    }
    account.start();
    if (store.config.keepalive.enabled) keepalive.start(); else keepalive.stop();
    if (store.config.points.enabled) points.start(); else points.stop();
    power.start();
  }

  function status() {
    return {
      ok: true,
      time: new Date(clock()).toISOString(),
      keepalive: keepalive.status(),
      points: points.status(),
      power: power.status(),
      auth: account.status(),
      notifications: notifier.status(),
      service: serviceStatus,
      system: systemStatus(),
    };
  }

  async function route(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true, service: 'teleagent-console' });
    if (method === 'GET' && STATIC.has(pathname)) {
      const [file, type] = STATIC.get(pathname);
      const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      return res.end(body);
    }
    if (method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (method === 'GET' && pathname === '/login') {
      if (panelAuth.check(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return page(res, 200, 'login.html');
    }
    if (method === 'GET' && pathname === '/') {
      if (!panelAuth.check(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return page(res, 200, 'index.html');
    }
    if (method !== 'GET' && method !== 'POST') return json(res, 405, { ok: false, error: '不支持的请求方法' }, { Allow: 'GET, POST' });

    let body = {};
    if (method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '请求来源不匹配' });
      try { body = await readBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { ok: false, error: safeError(error) }); }
    }

    if (method === 'POST' && pathname === '/api/panel/login') {
      try {
        if (!panelAuth.login(body.user, body.password, req.socket.remoteAddress || 'local')) return json(res, 401, { ok: false, error: '账号或密码不正确' });
        return json(res, 200, { ok: true }, { 'Set-Cookie': panelAuth.cookie(req) });
      } catch (error) { return json(res, 429, { ok: false, error: safeError(error) }); }
    }

    if (pathname.startsWith('/api/') && !panelAuth.check(req)) return json(res, 401, { ok: false, error: '请先登录工作台' });
    if (method === 'GET' && pathname === '/api/status') return json(res, 200, status());
    if (method === 'GET' && pathname === '/api/config') return json(res, 200, { ok: true, config: store.publicConfig(), notificationEvents: EVENTS });
    if (method === 'GET' && pathname === '/api/logs') return json(res, 200, { ok: true, logs: logger.tail(200) });
    if (method === 'POST' && pathname === '/api/panel/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': panelAuth.clearCookie() });

    try {
      if (method === 'POST' && pathname === '/api/config') {
        const config = store.update(body);
        syncBackground();
        return json(res, 200, { ok: true, config, notificationEvents: EVENTS });
      }
      if (method === 'POST' && pathname === '/api/keepalive/run') {
        const result = await keepalive.run('manual');
        return json(res, result.ok ? 200 : 502, { ...result, message: result.ok ? '本轮巡检已完成。' : result.error });
      }
      if (method === 'POST' && pathname === '/api/keepalive/toggle') {
        if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('保活开关值无效'), { statusCode: 400 });
        const config = store.update({ keepalive: { enabled: body.enabled } });
        syncBackground();
        return json(res, 200, { ok: true, config, message: body.enabled ? '自动巡检已恢复。' : '自动巡检已暂停。' });
      }
      if (method === 'POST' && pathname === '/api/points/refresh') {
        const result = await points.refresh();
        return json(res, result.ok ? 200 : 502, result);
      }
      if (method === 'POST' && pathname === '/api/points/claim') {
        const result = await points.claim('manual');
        return json(res, result.ok ? 200 : 502, result);
      }
      if (method === 'POST' && pathname === '/api/power/restart') {
        if (body.confirmation !== 'RESTART') throw Object.assign(new Error('重启必须确认 RESTART'), { statusCode: 400 });
        const result = await power.execute('restart', body.confirmation);
        return json(res, result.ok ? 200 : 502, result);
      }
      if (method === 'POST' && pathname === '/api/power/cancel') {
        const result = await power.execute('cancel');
        return json(res, result.ok ? 200 : 502, result);
      }
      if (method === 'POST' && pathname === '/api/power/rebuild') {
        if (body.confirmation !== 'RESET') throw Object.assign(new Error('重置必须确认 RESET'), { statusCode: 400 });
        const result = await power.execute('rebuild', body.confirmation);
        return json(res, result.ok ? 200 : 502, result);
      }
      if (method === 'POST' && pathname === '/api/notify/test') {
        await notifier.test();
        return json(res, 200, { ok: true, message: '测试通知已发送。' });
      }
      if (method === 'POST' && pathname === '/api/service/refresh') {
        const instance = await platform.instance();
        const data = Object.fromEntries(SAFE_SERVICE_FIELDS.filter(key => instance[key] != null).map(key => [key, instance[key]]));
        serviceStatus = { ok: true, data, message: '已读取目标云电脑状态', updatedAt: new Date(clock()).toISOString() };
        logger.info('Service', `平台状态已刷新：status=${instance.status}`);
        return json(res, 200, serviceStatus);
      }
      if (method === 'POST' && pathname === '/api/desktop/open') {
        const result = await platform.action('connect');
        const address = result?.data?.connectURL;
        let connectUrl;
        try { connectUrl = new URL(address); } catch { throw new Error('平台未返回有效的云电脑连接地址'); }
        if (connectUrl.protocol !== 'https:' || connectUrl.hostname !== 'pc.ctyun.cn' || connectUrl.username || connectUrl.password) throw new Error('平台返回的云电脑连接地址无效');
        logger.info('Desktop', '已获取一次性云电脑连接票据');
        return json(res, 200, { ok: true, url: connectUrl.href });
      }
      if (method === 'POST' && pathname === '/api/auth/token') {
        const result = await account.acceptToken(body.operationToken, body.instanceId);
        return json(res, 200, { ...result, message: '云账号凭据已保存。' });
      }
      if (method === 'POST' && pathname === '/api/auth/login') {
        const result = await account.loginAccount(body);
        if (result.requiresCaptcha) return json(res, 200, { ok: true, captcha: result.captcha });
        return json(res, 200, { ok: true, auth: result.auth, message: '云账号登录成功。' });
      }
      if (method === 'POST' && pathname === '/api/auth/relogin') {
        const result = await account.relogin();
        return json(res, 200, { ...result, message: '登录凭据已续期。' });
      }
      if (method === 'POST' && pathname === '/api/auth/logout') {
        if (body.confirmation !== 'LOGOUT') throw Object.assign(new Error('清除登录必须确认 LOGOUT'), { statusCode: 400 });
        await account.clear();
        return json(res, 200, { ok: true, message: '云账号登录凭据已清除。' });
      }
      return json(res, 404, { ok: false, error: '没有这个 API 路由' });
    } catch (error) {
      const code = error.statusCode || 502;
      logger.warn('API', `${method} ${pathname} 失败：${safeError(error)}`);
      return json(res, code, { ok: false, error: safeError(error) });
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    route(req, res).catch(error => {
      logger.error('HTTP', safeError(error));
      if (!res.headersSent) json(res, 500, { ok: false, error: '服务内部错误' });
      else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  function startBackground() { syncBackground(); }
  function stopBackground() { keepalive.stop(); points.stop(); power.stop(); account.stop(); }
  return { server, store, logger, panelAuth, platform, notifier, keepalive, points, power, account, status, startBackground, stopBackground };
}

if (require.main === module) {
  const app = createApplication();
  const port = Number(process.env.TA_PORT || 50004);
  const host = process.env.TA_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TA_PORT 无效');
  app.startBackground();
  app.server.listen(port, host, () => app.logger.info('Server', `TeleAgent 工作台已监听 ${host}:${port}`));
  const stop = () => {
    app.stopBackground();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = { createApplication, readBody, safeError, sameOrigin };
