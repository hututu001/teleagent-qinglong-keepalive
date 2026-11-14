'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { privateWrite, readJson } = require('./store');
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
class PanelAuth {
  constructor(dataDir, { user = process.env.TA_PANEL_USER || 'admin', password = process.env.TA_PANEL_PASSWORD } = {}) {
    this.user = user; this.attempts = new Map();
    const file = path.join(dataDir, 'panel-auth.json');
    this.saved = readJson(file, {});
    const existingPasswordValid = password && this.saved.hash && this.saved.salt
      && this.saved.user === user
      && equal(crypto.scryptSync(String(password), this.saved.salt, 32).toString('hex'), this.saved.hash);
    if (!existingPasswordValid && (password || !this.saved.hash)) {
      const plain = password || crypto.randomBytes(18).toString('base64url');
      this.saved = { user, salt: crypto.randomBytes(16).toString('hex'), key: crypto.randomBytes(32).toString('hex') };
      this.saved.hash = crypto.scryptSync(plain, this.saved.salt, 32).toString('hex');
      privateWrite(file, this.saved);
      if (!password) privateWrite(path.join(dataDir, 'initial-admin-password.txt'), plain + '\n');
    }
    this.user = this.saved.user;
  }
  verify(user, password) { const hash = crypto.scryptSync(String(password || ''), this.saved.salt, 32).toString('hex'); return equal(String(user || ''), this.user) && equal(hash, this.saved.hash); }
  login(user, password, address = 'local') {
    const now = Date.now(); const failures = (this.attempts.get(address) || []).filter(t => now - t < 600000);
    if (failures.length >= 8) throw new Error('登录失败次数较多，请 10 分钟后再试');
    if (!this.verify(user, password)) { failures.push(now); this.attempts.set(address, failures); return false; }
    this.attempts.delete(address); return true;
  }
  cookie(req) {
    const payload = Buffer.from(JSON.stringify({ user: this.user, exp: Date.now() + 7 * 86400000, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
    const mac = crypto.createHmac('sha256', this.saved.key + this.saved.hash).update(payload).digest('base64url');
    return `ta_session=${payload}.${mac}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
  }
  clearCookie() { return 'ta_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'; }
  check(req) {
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization || '');
    if (basic) { const value = Buffer.from(basic[1], 'base64').toString(); const i = value.indexOf(':'); return i >= 0 && this.verify(value.slice(0, i), value.slice(i + 1)); }
    const value = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('ta_session='))?.slice(11);
    if (!value) return false;
    const [payload, mac] = value.split('.'); if (!payload || !mac) return false;
    const expected = crypto.createHmac('sha256', this.saved.key + this.saved.hash).update(payload).digest('base64url');
    if (!equal(mac, expected)) return false;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url')); return data.user === this.user && data.exp > Date.now(); } catch { return false; }
  }
}
module.exports = { PanelAuth };
