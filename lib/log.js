'use strict';
const fs = require('node:fs');
const path = require('node:path');
function redact(value) {
  return String(value ?? '').replace(/eyJ[A-Za-z0-9_.-]+/g, '[凭据已隐藏]')
    .replace(/https?:\/\/[^\s"<>]*(?:token=|\/hook\/)[^\s"<>]*/gi, '[私有链接已隐藏]')
    .replace(/(operationToken\s*[=:]\s*)[^\s,;"}]+/gi, '$1[已隐藏]').slice(0, 2000);
}
class Logger {
  constructor(dataDir) { this.file = path.join(dataDir, 'events.log'); this.rows = []; try { this.rows = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-300).map(JSON.parse); } catch {} }
  write(level, scope, message) {
    const row = { time: new Date().toISOString(), level, scope: String(scope), message: redact(message) };
    this.rows.push(row); if (this.rows.length > 300) this.rows.shift();
    console.log(`[${row.level}] [${row.scope}] ${row.message}`);
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); if (fs.existsSync(this.file) && fs.statSync(this.file).size > 2 * 1024 * 1024) fs.writeFileSync(this.file, '', { mode: 0o600 }); fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 }); } catch {}
    return row;
  }
  info(scope, message) { return this.write('info', scope, message); }
  warn(scope, message) { return this.write('warn', scope, message); }
  error(scope, message) { return this.write('error', scope, message); }
  debug(scope, message) { return this.write('debug', scope, message); }
  tail(limit = 200) { return this.rows.slice(-Math.min(limit, 300)); }
}
module.exports = { Logger, redact };
