'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { privateWrite } = require('./store');
const { LoginService } = require('./login');
class AccountService {
  constructor({ store, platform, notify, log, onChange = () => {}, login = new LoginService() }) {
    Object.assign(this, { store, platform, notify, log, onChange, login }); this.timer = null; this.relogging = false; this.lastRenewal = 0; this.lastExpiryNotice = '';
    const file = path.join(store.dataDir, '.account-key');
    try { this.key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch { this.key = crypto.randomBytes(32); privateWrite(file, this.key.toString('hex')); }
  }
  payload() { try { return JSON.parse(Buffer.from(this.store.credentials.operationToken.split('.')[1], 'base64url')); } catch { return {}; } }
  status() {
    const payload = this.payload(), auth = this.store.config.auth;
    const account = auth.account || payload.userName || payload.accountName || '';
    return { ok: !!this.store.credentials.operationToken, instanceId: this.store.credentials.instanceId,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      daysLeft: payload.exp ? Math.max(0, (payload.exp * 1000 - Date.now()) / 86400000) : null,
      accountMasked: account ? (account.length > 5 ? account.slice(0, 3) + '****' + account.slice(-2) : '已登录') : '',
      hasPassword: !!auth.passwordEnc, autoRelogin: auth.autoRelogin, reloginDays: auth.reloginDays,
      relogging: this.relogging, error: this.error || null };
  }
  encrypt(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.'); }
  decrypt(value) { const [iv, tag, data] = value.split('.').map(x => Buffer.from(x, 'base64')); const cipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'); }
  async inform(key, title, content) { try { await this.notify.event(key, title, content); } catch (error) { this.log.warn('Notify', error.message); } }
  async acceptToken(operationToken, instanceId) {
    operationToken = String(operationToken || '').trim();
    if (!operationToken || operationToken.includes('\n')) throw new Error('请填写有效的单账号 operationToken');
    const instances = await this.platform.instances(operationToken);
    const target = String(instanceId || this.store.credentials.instanceId || '');
    let selected = instances.find(row => String(row.id) === target);
    if (!selected && instances.length === 1) selected = instances[0];
    if (!selected) throw new Error('请填写此账号下需要管理的目标实例 ID');
    this.store.setCredentials({ operationToken, instanceId: selected.id }); this.error = null;
    this.log.info('Account', '登录凭据已保存，目标实例已确认');
    await this.onChange();
    return { ok: true, auth: this.status() };
  }
  async loginAccount(body) {
    const result = await this.login.login(body);
    if (result.requiresCaptcha) return result;
    if (result.remember) { this.store.config.auth.account = result.account; this.store.config.auth.passwordEnc = this.encrypt(result.password); this.store.saveConfig(); }
    else if (body.account && this.store.config.auth.account !== result.account) { this.store.config.auth.account = ''; this.store.config.auth.passwordEnc = ''; this.store.saveConfig(); }
    await this.acceptToken(result.operationToken, body.instanceId);
    await this.inform('auth_success', '星辰账号登录成功', '登录凭据已更新。');
    return { ok: true, auth: this.status() };
  }
  async relogin() {
    const auth = this.store.config.auth;
    if (!auth.account || !auth.passwordEnc) throw new Error('请先登录并选择记住密码');
    if (this.relogging) throw new Error('登录续期正在进行');
    this.relogging = true;
    try { const result = await this.loginAccount({ account: auth.account, password: this.decrypt(auth.passwordEnc), remember: true }); if (result.requiresCaptcha) throw new Error('自动续期需要手动验证，请在账号页面重新登录'); return result; }
    finally { this.relogging = false; }
  }
  async clear() { this.store.setCredentials({ operationToken: '', instanceId: '' }); this.store.config.auth.account = ''; this.store.config.auth.passwordEnc = ''; this.store.saveConfig(); this.error = null; await this.onChange(); return { ok: true }; }
  async tick() {
    if (!this.store.credentials.operationToken) return;
    const status = this.status(), auth = this.store.config.auth, now = Date.now();
    if (status.daysLeft != null && status.daysLeft <= 3) { const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); if (this.lastExpiryNotice !== day) { this.lastExpiryNotice = day; await this.inform('auth_expiring', '星辰登录凭据即将到期', `剩余约 ${status.daysLeft.toFixed(1)} 天。`); } }
    if (auth.autoRelogin && auth.account && auth.passwordEnc && status.daysLeft != null && status.daysLeft <= auth.reloginDays && now - this.lastRenewal > 12 * 3600000) {
      this.lastRenewal = now;
      try { await this.relogin(); this.log.info('Account', '自动续期完成'); }
      catch (error) { this.error = error.message; this.log.warn('Account', error.message); await this.inform('auth_failure', '星辰登录续期失败', error.message); }
    }
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(error => this.log.warn('Account', error.message)), 60000); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }
}
module.exports = { AccountService };
