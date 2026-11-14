# TeleAgent 青龙保活脚本

面向 TeleAgent（星辰超级智能体）云电脑的单轮巡检脚本，通过青龙定时任务查询指定实例、按需启动、请求活动刷新并获取桌面连接票据。

每个任务固定一个目标实例。正常巡检、自动启动成功，以及重试后恢复成功都只记日志；完整流程连续三次失败后，才调用青龙现有通知模块。

## 当前能力与效果范围

每轮调用顺序是：

```text
instance/list
  → 按实例状态启动或等待就绪
  → instance/refresh
  → instance/connect
  → 本轮结束
```

`instance/refresh` 是官方网页在文件访问前使用的刷新接口。本脚本复用该接口，但接口受理成功、取到 `connectURL`，只能证明对应请求成功，不能据此认定已经实现永久在线。防休眠效果需要在没有人工桌面连接的条件下持续观察实例原始状态、休眠和启动记录。

脚本不会打开连接票据 URL，也不建立常驻远程桌面会话。本项目不包含 SSH 安装、反向隧道或 SSH 连通性监控。

## 环境要求

- Node.js 20 或更新版本。
- 可访问 TeleAgent 官方接口的运行环境。
- 青龙现有的 `sendNotify.js` 通知模块及相应通知配置。
- 当前账号有效的 `operationToken`，以及该账号名下目标云电脑的实例 ID。

业务请求使用 Node.js 内置 `fetch`、`AbortSignal` 等功能，没有第三方 npm 依赖，无需先运行 `npm install`。通知功能复用青龙已安装的模块，本仓库不打包通知渠道实现。

## 先调整安装路径

仓库保留了部署版本中的绝对路径。不同青龙安装方式的目录不同，首次运行前需要核对并调整：

| 文件 | 需要核对的位置 |
| --- | --- |
| `qinglong-keepalive.js` | `qlSendNotify` 的 `require(...)` 路径 |
| `teleagent-qinglong-runner.js` | `notify` 的 `require(...)` 路径、`credentialsPath`、`helperPath` |

两个文件里的通知模块默认路径是：

```text
/opt/bohrclaw_workspace/qinglong/app/data/scripts/sendNotify.js
```

请改成自己青龙安装中实际的 `sendNotify.js` 路径，例如某些容器布局使用 `/ql/data/scripts/sendNotify.js`。如果运行在容器里，应填写容器内可见的路径；宿主机的私有配置和脚本目录需要按部署方式挂载进去。

## 方式一：青龙环境变量

将 `qinglong-keepalive.js` 放入青龙脚本目录，并配置：

| 环境变量 | 必填 | 含义 |
| --- | --- | --- |
| `TELEAGENT_TOKEN` | 是 | 当前账号的 `operationToken` |
| `TELEAGENT_INSTANCE_ID` | 是 | 本任务唯一允许操作的实例 ID |

可从已登录的 [TeleAgent 官方网页](https://agent.teleai.com.cn/teleagent) 开发者工具中核对 Cookie 里的 `operationToken`，以及 `/teleagent-manager/v1/instance/list` 返回的目标实例 ID。不要把实际值写入仓库或公开日志。

青龙定时任务配置：

```text
命令：task qinglong-keepalive.js
定时：*/5 * * * *
```

如果脚本放在子目录，命令中使用对应相对路径。关闭任务的多实例并发执行，避免上一轮尚未结束时同时操作同一实例。

这是每 5 分钟触发一次的单轮任务，脚本完成后退出。间隔由青龙 Cron 决定，脚本内部不启动常驻循环。需要其他周期时，在青龙修改定时规则。

建议每个任务配置一个账号与一个实例。虽然保留了上游多 token 的解析格式，但 `TELEAGENT_INSTANCE_ID` 在同一任务内只有一个值；不同账号或实例应使用独立任务和配置。

`operationToken` 失效后需要重新登录并更新配置，本版本不自动刷新登录凭据。

## 方式二：私有 credentials.json 与 runner

`teleagent-qinglong-runner.js` 从私有文件加载凭据，注入当前任务进程的环境变量，再加载核心脚本。适合将凭据保存在青龙脚本目录之外的部署。

默认文件布局：

```text
/opt/teleagent-cloud-helper/
├── credentials.json
└── qinglong-keepalive.js

<青龙脚本目录>/teleagent-qinglong-runner.js
```

复制 `credentials.example.json` 为私有目录中的 `credentials.json`，只在私有文件中填入自己的值：

```json
{
  "operationToken": "REPLACE_WITH_YOUR_OPERATION_TOKEN",
  "instanceId": "REPLACE_WITH_YOUR_INSTANCE_ID"
}
```

核对 runner 中的 `credentialsPath`、`helperPath` 和通知模块路径。运行任务的系统用户必须能读取这些文件。以 root 执行的 Linux 部署可将私有目录设为 `700`、`credentials.json` 设为 `600`；其他运行用户应按实际所有权设置等效的最小读取权限。

在青龙使用以下任务：

```text
命令：task teleagent-qinglong-runner.js
定时：*/5 * * * *
```

runner 会清除当前任务进程中的 `http_proxy`、`https_proxy`、`all_proxy` 及其大写形式。请确保该进程可以直接访问官方站点。这项处理只作用于该任务进程。

私有凭据文件不应提交到 Git。仓库只提供占位示例，不包含任何可用凭据。

## 状态分支与重试

| 查询到的状态 | 本轮处理 |
| --- | --- |
| `0`、`3` | 请求 `instance/start`，随后等待可连接状态 |
| `1`、`2`、`5`、`6` | 只查询等待就绪，不重复请求启动 |
| `4`、`100` | 请求 `instance/refresh`，再获取连接票据 |
| `7` 或其他未知状态 | 本次尝试失败，不请求启动、刷新或连接 |

等待就绪采用每次约 10 秒的查询间隔，每次尝试的等待截止时间为实际经过 60 秒；查询请求超时不会超过剩余等待时间。普通单次 HTTP 请求的超时为 20 秒。

查询、启动、活动刷新或取票失败，都会进入完整流程重试：最多尝试三次，相邻尝试间隔 5 秒。每次重试先重新查询实例状态；如果实例已经处于过渡态或可连接态，就按新状态继续处理。

脚本检查 HTTP 状态、接口业务错误及必要字段。目标实例不存在时直接记为失败，不回退操作账号列表里的其他实例。

## 通知与日志

- 正常巡检成功：不通知。
- 启动后恢复成功：不通知。
- 第一、第二次失败，随后重试成功：不通知。
- 完整流程连续三次失败：汇总失败原因，通过青龙 `sendNotify` 发出一条通知，并以非零退出码结束。
- 未配置 Token、私有凭据文件无法读取等启动错误：直接记录并调用失败通知。

旧的 `TELEAGENT_NOTIFY=all` 不会启用成功消息。通知实际使用什么渠道、能否送达，取决于现有青龙通知配置；通知调用异常会写入任务日志。

日志会记录实例状态、状态原因、重试次数以及刷新与取票结果。核心脚本会隐藏接口错误消息中的常见连接地址和 token 格式；查看或分享日志前仍应检查其中的账号与实例信息。

## 离线测试

```bash
node tests/keepalive.test.cjs
# 或
npm test
```

当前包含 27 个离线模拟用例，覆盖目标实例限制、各状态分支、启动与就绪等待、HTTP/业务错误、刷新和取票失败后的重试，以及成功静默、最终失败才通知等行为。测试用 VM stub 替换网络和通知函数，不读取实际凭据，不调用官方接口，也不发送通知。

这些测试验证代码分支，不代表已经验证真实云电脑可以连续在线 1 小时或 24 小时。

## 来源与许可

核心脚本派生自 [mojed123/teleagent-cloud-helper](https://github.com/mojed123/teleagent-cloud-helper) 的青龙脚本。仓库保留上游 MIT 许可全文，改动与来源说明见 [NOTICE](NOTICE)。

