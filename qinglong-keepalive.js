/**
 * TeleAgent（星辰智能体）云电脑保活 —— 青龙面板版（支持多账号）
 * ------------------------------------------------------------------
 * 依赖：浏览器抓到的 operationToken（插件「TeleAgent CK 抓取助手」复制出来的值）。
 *
 * 环境变量 TELEAGENT_TOKEN 支持多账号，规则：
 *   - 多条之间用「换行」或「&」分隔；
 *   - 每条格式：  [备注名#]operationToken值
 *     备注名可省略；省略时自动用 token 里的 userName。
 *   示例（3 个账号）：
 *     老板号#eyJhbGciOi...
 *     备用号#eyJhbGciOi...
 *     eyJhbGciOi...            ← 不带备注也行
 *   （多条用 & 连成一行也可以：  老板号#xxx&备用号#yyy&zzz  ）
 *
 * 必填目标：TELEAGENT_INSTANCE_ID = 本任务允许操作的云电脑实例 ID
 *
 * 容错：完整单账号流程最多尝试 3 次，间隔 5 秒，每次先重新查询状态。
 * 通知：仅最终失败时通知；正常巡检和启动恢复成功均不通知。
 *
 * 定时任务 cron 建议：每 5 分钟一轮；脚本类型：nodejs
 *
 * 逻辑：只处理指定实例；仅状态 0/3 请求启动；就绪后刷新活动并获取桌面连接票据。
 *      换票成功不代表已证实长期在线，需结合持续状态及 SSH 连通性另行验证。
 * ------------------------------------------------------------------
 */

const BASE = 'https://agent.teleai.com.cn/teleagent-manager/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0';
const TOKEN_ENV = 'TELEAGENT_TOKEN';
const INSTANCE_ID = (process.env.TELEAGENT_INSTANCE_ID || '').trim();
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const READY_WAIT_MS = 60000;
const READY_STATES = new Set([4, 100]);
const WAITING_STATES = new Set([1, 2, 5, 6]);
const qlSendNotify = require('/opt/bohrclaw_workspace/qinglong/app/data/scripts/sendNotify.js').sendNotify;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 通知（兼容新旧版青龙） ----------
async function sendNotify(title, content) {
  try {
    await qlSendNotify(title, content);
  } catch (e) {
    console.log(`[通知失败] ${e.message}`);
  }
}

// ---------- JWT 解析（取 userName / 有效期，作备注兜底） ----------
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function parseJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(b64urlDecode(parts[1]));
  } catch (e) { return null; }
}

// ---------- 多账号解析 ----------
function parseAccounts() {
  const raw = (process.env[TOKEN_ENV] || '').trim();
  if (!raw) return [];

  const parts = raw.split(/[\n&]+/).map((s) => s.trim()).filter(Boolean);
  const accounts = [];
  const seen = new Set();

  for (const p of parts) {
    let remark = '';
    let token = p;
    const idx = p.indexOf('#');
    if (idx > 0) {
      remark = p.slice(0, idx).trim();
      token = p.slice(idx + 1).trim();
    }
    if (!token) continue;
    if (seen.has(token)) continue; // 同 token 去重
    seen.add(token);

    // 没写备注就用 JWT 里的账号名
    if (!remark) {
      const pl = parseJwt(token);
      remark = (pl && (pl.userName || pl.accountName || pl.loginName)) || ('账号' + (accounts.length + 1));
    }
    accounts.push({ remark, token });
  }
  return accounts;
}

// ---------- HTTP ----------
function safeMessage(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[连接地址已隐藏]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[Token已隐藏]')
    .replace(/operationToken\s*[=:]\s*[^\s,;"}]+/gi, 'operationToken=[已隐藏]')
    .slice(0, 180);
}

async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 20000, allowEmpty = false } = {}) {
  const h = {
    'User-Agent': UA,
    'x-client-platform': 'web',
    'Referer': 'https://agent.teleai.com.cn/teleagent',
    ...headers
  };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
  });
  const text = await res.text();
  let payload;
  if (!text.trim() && allowEmpty && res.ok) return {};
  try { payload = JSON.parse(text); } catch (e) { throw new Error(`响应非 JSON（HTTP ${res.status}）`); }
  const detail = payload && (payload.error?.message || payload.error?.msg || payload.message || payload.msg);
  if (!res.ok) throw new Error(`HTTP ${res.status}${detail ? '：' + safeMessage(detail) : ''}`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('响应不是有效的接口对象');
  if (payload.code != null && ![0, 200].includes(Number(payload.code))) {
    throw new Error(`接口错误 ${safeMessage(payload.code)}${detail ? '：' + safeMessage(detail) : ''}`);
  }
  if (payload.error?.code != null && Number(payload.error.code) !== 0) {
    throw new Error(`接口错误 ${safeMessage(payload.error.code)}${detail ? '：' + safeMessage(detail) : ''}`);
  }
  return payload;
}

async function getInstance(cookie, timeoutMs = 20000) {
  const response = await httpJson(`${BASE}/instance/list`, { headers: { Cookie: cookie }, timeoutMs });
  if (!Array.isArray(response.data)) throw new Error('实例列表缺少有效 data 数组');
  const instance = response.data.find((x) => String(x.id) === INSTANCE_ID);
  if (!instance) throw new Error(`指定实例 ${INSTANCE_ID} 不在当前账号列表中，未操作其他实例`);
  if (instance.status == null || !Number.isFinite(Number(instance.status))) throw new Error('实例状态无效');
  return { ...instance, status: Number(instance.status) };
}

async function waitUntilReady(cookie, remark, initialStatus) {
  const deadline = Date.now() + READY_WAIT_MS;
  let lastStatus = initialStatus;
  while (Date.now() < deadline) {
    await sleep(Math.min(10000, deadline - Date.now()));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const instance = await getInstance(cookie, Math.min(20000, remaining));
    lastStatus = instance.status;
    console.log(`[${remark}] 等待就绪，status=${lastStatus}`);
    if (READY_STATES.has(lastStatus)) return instance;
    if (![0, 3].includes(lastStatus) && !WAITING_STATES.has(lastStatus)) {
      throw new Error(`实例状态 ${lastStatus} 暂未就绪，未发送 start/connect`);
    }
  }
  throw new Error(`等待就绪达到 60 秒，最后状态 ${lastStatus}，未发送 connect`);
}

// ---------- 单账号保活 ----------
// 返回 { remark, status: 'ok'|'recovered'|'fail', msg }
async function keepAliveOne(account, context) {
  const { remark, token } = account;
  const cookie = 'operationToken=' + token;
  if (!INSTANCE_ID) throw new Error('未配置 TELEAGENT_INSTANCE_ID，未操作任何实例');

  // 1. 拉实例列表
  let ins = await getInstance(cookie);
  console.log(`[${remark}] 实例 id=${ins.id} status=${ins.status} statusReason=${ins.statusReason ?? 'unknown'}`);

  // 2. 仅 0/3 请求启动；每次重试先查状态，启动/排队/重启中只等待。
  if (ins.status === 0 || ins.status === 3) {
    const desc = ins.status === 3 ? '已休眠' : '未运行';
    console.log(`[${remark}] 实例${desc}，调用 start…`);
    context.startRequested = true;
    await httpJson(`${BASE}/instance/start`, { method: 'POST', body: { id: ins.id }, headers: { Cookie: cookie }, allowEmpty: true });
    ins = await waitUntilReady(cookie, remark, ins.status);
    console.log(`[${remark}] 已回到可连接状态`);
  } else if (WAITING_STATES.has(ins.status)) {
    console.log(`[${remark}] 实例正在启动/排队/重启，等待就绪，不重复请求 start`);
    ins = await waitUntilReady(cookie, remark, ins.status);
  } else if (!READY_STATES.has(ins.status)) {
    throw new Error(`实例 ${ins.id} 状态 ${ins.status} 暂未就绪，未发送 start/connect`);
  }

  // 3. 复用官方文件访问前的活动刷新接口；防休眠效果需观察原始状态。
  await httpJson(`${BASE}/instance/refresh`, { method: 'POST', body: { id: ins.id }, headers: { Cookie: cookie }, allowEmpty: true });
  console.log(`[${remark}] 活动刷新请求成功；防休眠效果观察中`);

  // 4. 获取连接票据；长期在线效果需独立观察
  const c = await httpJson(`${BASE}/instance/connect`, { method: 'POST', body: { id: ins.id }, headers: { Cookie: cookie } });
  if (typeof c.data?.connectURL !== 'string' || !c.data.connectURL.trim()) throw new Error('connect 未返回有效连接地址');

  console.log(`✅ [${remark}] 桌面连接票据获取成功：实例 ${ins.id}；长期在线待持续验证`);
  return { remark, status: context.startRequested ? 'recovered' : 'ok', msg: `实例 ${ins.id} 连接票据获取成功${context.startRequested ? '（已请求拉起）' : ''}，长期在线待验证` };
}

async function keepAliveWithRetry(account) {
  const context = { startRequested: false };
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await keepAliveOne(account, context);
      console.log(`[${account.remark}] 第 ${attempt}/${MAX_ATTEMPTS} 次尝试成功`);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      console.log(`[${account.remark}] 第 ${attempt}/${MAX_ATTEMPTS} 次尝试失败：${safeMessage(error.message)}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[${account.remark}] 5 秒后重试，重试前重新查询实例状态`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`连续 ${MAX_ATTEMPTS} 次尝试失败：${safeMessage(lastError?.message)}`);
}

// ---------- 主流程 ----------
async function main() {
  const accounts = parseAccounts();
  if (!accounts.length) {
    console.log('❌ 未配置环境变量 TELEAGENT_TOKEN');
    process.exitCode = 1;
    await sendNotify('TeleAgent 保活失败', '未配置环境变量 TELEAGENT_TOKEN\n支持多账号：多条用换行或 & 分隔，格式 [备注名#]operationToken');
    return;
  }
  console.log(`共 ${accounts.length} 个账号：${accounts.map((a) => a.remark).join('、')}`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    try {
      const r = await keepAliveWithRetry(acc);
      results.push({ ...r, ok: true });
    } catch (e) {
      console.log(`❌ [${acc.remark}] ${e.message}`);
      results.push({ remark: acc.remark, status: 'fail', ok: false, msg: e.message });
    }
    if (i < accounts.length - 1) await sleep(2000); // 账号间小间隔，降低风控
  }

  // 汇总
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const recoveredCount = results.filter((r) => r.status === 'recovered').length;
  if (failCount > 0) process.exitCode = 1;
  console.log(`\n汇总：成功 ${okCount} / 失败 ${failCount}${recoveredCount ? '，拉起 ' + recoveredCount + ' 个' : ''}`);

  // 仅完整流程三次尝试均失败时通知；成功和拉起成功只记日志。
  if (failCount > 0) {
    const lines = results.filter((r) => !r.ok).map((r) => `❌ ${r.remark}：${r.msg}`);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await sendNotify(
      'TeleAgent 保活失败（重试已用尽）',
      `${lines.join('\n')}\n\n成功 ${okCount} / 失败 ${failCount}\n时间：${now}`
    );
  }
}

main().catch(async (e) => {
  process.exitCode = 1;
  console.log(`❌ ${e.message}`);
  await sendNotify('TeleAgent 保活异常', `原因：${e.message}\n时间：${new Date().toLocaleString('zh-CN')}`);
});

