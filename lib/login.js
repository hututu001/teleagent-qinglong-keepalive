'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const AUTH_BASE = 'https://www.teleai.com.cn/teleai-api';
const CLIENT_ID = 'Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi';
const CALLBACK = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?source=4&state=https://agent.teleai.com.cn/teleagent';
const SUCCESS = '10980001';

// Decode the PNG row filters used by the official puzzle images.
function puzzleOffset(base64) {
  const png = Buffer.from(base64, 'base64');
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('验证码图片格式不支持');
  let width, height, channels; const chunks = [];
  for (let pos = 8; pos + 12 <= png.length;) {
    const size = png.readUInt32BE(pos), type = png.toString('ascii', pos + 4, pos + 8);
    const bytes = png.subarray(pos + 8, pos + 8 + size);
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4);
      channels = bytes[9] === 2 ? 3 : bytes[9] === 6 ? 4 : 0;
      if (!channels || bytes[8] !== 8 || bytes[12] !== 0 || width * height > 2000000) throw new Error('请手动完成验证码');
    }
    if (type === 'IDAT') chunks.push(bytes);
    pos += size + 12;
    if (type === 'IEND') break;
  }
  if (!width || !height || !channels) throw new Error('验证码图片无效');
  const stream = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0, cursor = 0; y < height; y++) {
    const filter = stream[cursor++];
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const up = y ? pixels[index - stride] : 0;
      const upperLeft = y && x >= channels ? pixels[index - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft, distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upperLeft)];
        predictor = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upperLeft;
      } else if (filter !== 0) throw new Error('验证码图片滤波不支持');
      pixels[index] = (stream[cursor++] + predictor) & 255;
    }
  }
  const seen = new Uint8Array(width * height);
  const white = index => { const i = index * channels; const a = pixels[i], b = pixels[i + 1], c = pixels[i + 2]; return Math.min(a, b, c) > 225 && Math.max(a, b, c) - Math.min(a, b, c) < 18; };
  let best = null;
  for (let cell = 0; cell < seen.length; cell++) {
    if (seen[cell] || !white(cell)) continue;
    const queue = [cell]; seen[cell] = 1; let minX = cell % width;
    for (let at = 0; at < queue.length; at++) {
      const current = queue[at], x = current % width, y = Math.floor(current / width);
      minX = Math.min(minX, x);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || seen[next] || !white(next)) continue;
        seen[next] = 1; queue.push(next);
      }
    }
    if (queue.length > 60 && (!best || queue.length > best.size)) best = { size: queue.length, x: minX };
  }
  if (!best) throw new Error('请手动完成验证码');
  return Math.max(0, best.x - 2);
}
function ecb(key, value) { const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null); return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64'); }

class LoginService {
  constructor({ fetchImpl = global.fetch } = {}) { this.fetch = fetchImpl; this.pending = new Map(); }
  async fetchAuth(route, body) {
    const response = await this.fetch(AUTH_BASE + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.teleai.com.cn', Referer: 'https://www.teleai.com.cn/master-auth', 'User-Agent': 'Mozilla/5.0' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`登录服务 HTTP ${response.status}`);
    return response.json();
  }
  async challenge() {
    const result = await this.fetchAuth('/upms/public/captcha/get', { captchaType: 'blockPuzzle' });
    if (!result.repData?.originalImageBase64 || !result.repData?.secretKey || !result.repData?.token) throw new Error('无法获取登录验证图');
    return result.repData;
  }
  async checkChallenge(challenge, offset) {
    if (!Number.isFinite(Number(offset)) || Number(offset) < 0 || Number(offset) > 2000) throw new Error('无效的滑块位置');
    const point = JSON.stringify({ x: Math.round(Number(offset)), y: 5 });
    const response = await this.fetchAuth('/upms/public/captcha/check', { captchaType: 'blockPuzzle', token: challenge.token, pointJson: ecb(challenge.secretKey, point) });
    if (response.repCode !== '0000') throw new Error('滑块验证未通过，请重新登录获取新验证图');
    return { captchaVerification: ecb(challenge.secretKey, `${challenge.token}---${point}`) };
  }
  expose(pending) {
    const id = crypto.randomBytes(20).toString('hex');
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 10) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(id, { ...pending, expires: Date.now() + 300000 });
    return { ok: false, requiresCaptcha: true, captcha: { id, originalImageBase64: pending.challenge.originalImageBase64, jigsawImageBase64: pending.challenge.jigsawImageBase64 || '' } };
  }
  async login({ account, password, remember = false, captchaId, offset }) {
    let pending;
    if (captchaId) {
      pending = this.pending.get(String(captchaId)); this.pending.delete(String(captchaId));
      if (!pending || pending.expires < Date.now()) throw new Error('验证图已过期，请重新登录');
      const proof = await this.checkChallenge(pending.challenge, offset);
      return this.exchange(pending, proof);
    }
    account = String(account || '').trim().toLowerCase(); password = String(password || '');
    if (!account || !password) throw new Error('请填写账号和密码');
    const rsa = await this.fetchAuth('/upms/public/auth/getRsaPublicKey');
    if (String(rsa.code) !== SUCCESS || !rsa.data?.publicKey || !rsa.data?.keyId) throw new Error('无法获取登录加密公钥');
    for (let attempt = 0; attempt < 3; attempt++) {
      const challenge = await this.challenge();
      pending = { account, password, remember, rsa: rsa.data, challenge };
      let proof;
      try { proof = await this.checkChallenge(challenge, puzzleOffset(challenge.originalImageBase64)); }
      catch { if (attempt === 2) return this.expose(pending); continue; }
      return this.exchange(pending, proof);
    }
  }
  async exchange(pending, proof) {
    const { account, password, remember, rsa } = pending;
    const timestamp = Date.now(), requestId = crypto.randomUUID();
    const key = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
    cipher.setAAD(Buffer.from(`loginName=${account}&keyId=${rsa.keyId}&timestamp=${timestamp}&requestId=${requestId}&clientId=${CLIENT_ID}`));
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(rsa.publicKey, 'base64'), format: 'der', type: 'spki' });
    const encrypted = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.concat([key, iv]));
    const result = await this.fetchAuth('/upms/public/auth/accountNameLogin', {
      loginName: account, keyId: rsa.keyId, timestamp, requestId, redirectUri: CALLBACK,
      clientId: CLIENT_ID, encryptedKeyIv: encrypted.toString('base64'), ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), invitationCode: '', captchaCheckResult: proof, publicKey: rsa.publicKey,
    });
    if (String(result.code) !== SUCCESS) throw new Error(result.message || '账号登录失败');
    let url = result.data?.redirectUri;
    if (!url) throw new Error('登录服务未返回回跳地址');
    for (let hop = 0; hop < 10; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.hostname !== 'agent.teleai.com.cn') throw new Error('登录回跳地址无效');
      const response = await this.fetch(target, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
      for (const value of cookies) { const match = /(?:^|,\s*)operationToken=([^;,\s]+)/.exec(value); if (match) return { operationToken: match[1], account, password, remember }; }
      const location = response.headers.get('location');
      if (location) { url = new URL(location, target).href; continue; }
      const html = await response.text(); const match = /(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|location\.replace\(\s*['"]([^'"]+)['"]/.exec(html);
      if (!match) break; url = new URL(match[1] || match[2], target).href;
    }
    throw new Error('登录完成但未取得云电脑登录凭据');
  }
}
module.exports = { LoginService, puzzleOffset };
