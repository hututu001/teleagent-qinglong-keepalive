'use strict';
const { redact } = require('./log');
const BASES = { manager: 'https://agent.teleai.com.cn/teleagent-manager/v1', points: 'https://agent.teleai.com.cn/superCowork/sapi' };
class PlatformClient {
  constructor({ getCredentials, fetchImpl = global.fetch }) { this.getCredentials = getCredentials; this.fetch = fetchImpl; }
  get instanceId() { return String(this.getCredentials().instanceId || ''); }
  async request(route, { method = 'GET', body, base = 'manager', timeoutMs = 20000, allowEmpty = false, token } = {}) {
    if (!BASES[base] || !route.startsWith('/') || route.startsWith('//')) throw new Error('无效平台接口');
    const credential = token || this.getCredentials().operationToken;
    if (!credential) throw new Error('尚未配置星辰登录凭据');
    const headers = { Cookie: `operationToken=${credential}`, Referer: 'https://agent.teleai.com.cn/teleagent', 'x-client-platform': 'web', 'User-Agent': 'Mozilla/5.0 TeleAgentConsole/0.2', Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetch(BASES[base] + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) }); }
    catch (error) { throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError' ? '平台请求超时' : '平台网络请求失败'); }
    const text = await response.text();
    if (allowEmpty && response.ok && !text.trim()) return {};
    let result; try { result = JSON.parse(text); } catch { throw new Error(`平台响应不是 JSON（HTTP ${response.status}）`); }
    const detail = result?.error?.message || result?.error?.msg || result?.message || result?.msg;
    if (!response.ok) throw new Error(`HTTP ${response.status}${detail ? '：' + redact(detail) : ''}`);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('平台响应格式无效');
    const code = result.code != null && ![0, 200].includes(Number(result.code)) ? result.code : (result.error?.code != null && Number(result.error.code) !== 0 ? result.error.code : null);
    if (code != null || result.success === false) throw new Error(`平台业务失败${code != null ? ' ' + code : ''}${detail ? '：' + redact(detail) : ''}`);
    return result;
  }
  async instances(token) { const result = await this.request('/instance/list', { token }); if (!Array.isArray(result.data)) throw new Error('实例列表无效'); return result.data; }
  async instance(options = {}) {
    if (!this.instanceId) throw new Error('请先选择目标云电脑实例');
    const response = await this.request('/instance/list', options);
    if (!Array.isArray(response.data)) throw new Error('实例列表无效');
    const instance = response.data.find(row => String(row.id) === this.instanceId);
    if (!instance) throw new Error('指定实例不在当前账号中，未操作其他实例');
    if (instance.status == null || !Number.isFinite(Number(instance.status))) throw new Error('实例状态无效');
    return { ...instance, status: Number(instance.status) };
  }
  async action(name) {
    if (!['start', 'refresh', 'connect', 'restart', 'rebuild', 'cancel'].includes(name)) throw new Error('不支持的实例操作');
    await this.instance();
    return this.request('/instance/' + name, { method: 'POST', body: { id: this.instanceId }, allowEmpty: name !== 'connect' });
  }
}
module.exports = { PlatformClient, BASES };
