'use strict';

// Qinglong scheduled entry point. The operationToken stays in the root-only
// credentials file and is loaded only into this short-lived task process.
for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[name];
}

const fs = require('node:fs');
const credentialsPath = '/opt/teleagent-cloud-helper/credentials.json';
const helperPath = '/opt/teleagent-cloud-helper/qinglong-keepalive.js';
const notify = require('/opt/bohrclaw_workspace/qinglong/app/data/scripts/sendNotify.js').sendNotify;

try {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (!credentials.operationToken || !credentials.instanceId) {
    throw new Error('TeleAgent 私有凭据缺少 operationToken 或 instanceId');
  }
  process.env.TELEAGENT_TOKEN = credentials.operationToken;
  process.env.TELEAGENT_INSTANCE_ID = credentials.instanceId;
  require(helperPath);
} catch (error) {
  console.error(`TeleAgent Qinglong 启动失败：${error.message}`);
  process.exitCode = 1;
  Promise.resolve(notify('TeleAgent 保活异常', `任务启动失败：${error.message}`)).catch((notifyError) => {
    console.error(`青龙通知失败：${notifyError.message}`);
  });
}
