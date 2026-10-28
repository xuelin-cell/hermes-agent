# 云端消息平台部署与验收

首期范围：5G 文本，三张 PG 表。

此能力可选，默认不启动。`009_messaging.sql` 自动增加 `messaging_bindings`、
`messaging_inbox`、`messaging_outbox`；执行租约放在收件箱，实例执行回执保存在
`HERMES_HOME/messaging-executions.db`，随已有状态归档恢复。不要在对象存储卷直接运行 SQLite。

常驻 `channels` 服务复用桌面 5G 协议，先持久化消息再 ACK；入口唤醒 Cube 实例，
实例主动通过入口连接 channels，使用现有 Hermes RelayAdapter 和 WebSocketRelayTransport。
机器人 SK 只以现有 CredentialCipher 加密后保存在 PG，不下发给浏览器、模型或实例。
通道只使用短信登录 `plan` 内的 `agentIdCloud`、`agentKeyCloud`、`ipUrl`，不使用
personal 字段或普通 my-plan 刷新结果。绑定初始为停用，用户手动连接后才接管。

启用步骤：

1. 准备专用测试 cloud Agent，或先停止 UniClaw 对同一个 cloud Agent 的连接。
2. 在 `entry.env` 设置 `MT_CHANNELS_RELAY_URL`，例如
   `ws://192.168.212.116:18081/hermes/__entry/messaging/relay`。
   所有沙箱计算节点都必须能连到它；HTTPS 部署改为 `wss://`。
3. 设置 `MT_CHANNELS_GATEWAY_ORIGINS` 为短信登录 `ipUrl` 的真实可信 origin，
   例如 `https://网关域名:端口`，多个用逗号分隔，不填任意用户提供的地址。
4. 生成一次 `MT_CHANNELS_KEY` 随机密钥保存到同一 `entry.env`。不要重新生成已有密钥。
   可以在部署目录执行以下命令（不打印密钥）：

   ```bash
   python3 - <<'PY'
   import os, secrets
   from pathlib import Path
   p = Path('entry.env')
   lines = p.read_text().splitlines()
   if not any(line.startswith('MT_CHANNELS_KEY=') and line.split('=',1)[1].strip() for line in lines):
       lines = [line for line in lines if not line.startswith('MT_CHANNELS_KEY=')]
       lines.append('MT_CHANNELS_KEY='+secrets.token_hex(32))
       p.write_text('\n'.join(lines)+'\n')
       os.chmod(p,0o600)
   PY
   ```

5. 保持 `MT_BACKEND=cube`、`MT_PG_LOCK=1`，执行 `bash deploy.sh all` 更新模板、
   前端、入口和 channels。没有配置密钥的部署不启动 channels。
6. 重新短信登录以获取 cloud 凭据，打开“消息平台”，点击 5G 卡片“重新连接”。
   状态必须实际变为已连接，不能仅凭“有凭据”验收。

验收：关闭浏览器后发送一条 5G 文本，应自动唤醒实例并收到一条最终回复。
重复投递同一上游消息不应重复运行 agent；入口重启应保留常驻平台连接。
实例 logs/cloud-messaging.log 记录执行进程日志，`docker logs hermes-mt-channels`
查看接入服务日志，避免复制或公开日志里的业务数据。

边界：首期只支持文本，不提供微信、钉钉、飞书、企微或媒体入口。发送后未收到网关 ACK
会标为 `unknown`，不会自动重发或补发失败文本；工具执行中崩溃则隔离为 `uncertain`，
不自动重跑。需核对原任务后再由用户决定后续动作。单用户同时仅执行一条平台消息；
首期是单个活动接入服务，不宣称跨机器故障切换的严格外部 fencing。
