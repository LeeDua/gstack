# Webshell Handoff SOP

## 1. 目的

在需要人工 SSO / MFA / CAPTCHA 介入时，确保 `browse handoff` 打开的浏览器不会“瞬间关闭”，并且后续 `resume` 能稳定接续自动化。

## 2. 适用场景

- 内网 webshell 需要人工登录、授权、验证码
- 终端输入焦点必须由用户先点一次
- 自动化执行命令出现 `about:blank`、无有效 websocket 输出

## 3. 标准流程

1. 启动独立 session
- 设定固定 `BROWSE_SESSION_NAME`
- 设定固定 `BROWSE_STATE_FILE`

2. 启动 webshell run
- `browse webshell start <url> <run_id>`

3. 进入 handoff
- `browse handoff "<message>"`
- 等待用户在可见浏览器完成登录并点终端输入区

4. 恢复自动化
- `browse resume`
- `browse webshell preflight <run_id>`
- `browse webshell cmd <run_id> -- '<short command>'`

## 4. 关键约束（避免浏览器立即关闭）

实现约束：CLI 启动 server 进程必须使用 detached 模式（非 Windows）。

- 要求：`Bun.spawn(..., { detached: !IS_WINDOWS, ... })`
- 原因：部分托管执行器会在命令结束后回收父进程组；若未 detached，server/headed Chromium 会被连带终止
- 效果：`handoff` 后可见浏览器由 server 持续托管，不随单次 CLI 调用结束而退出

## 5. 常见故障与处理

1. 现象：`HANDOFF: Browser opened ...` 后窗口立刻消失
- 排查：确认 CLI 是否以 detached 模式启动 server
- 处理：升级到包含 detached 修复的版本

2. 现象：`about:blank`
- 处理：`webshell preflight <run_id> [url]` 后再执行命令

3. 现象：`TIMEOUT_NO_END_MARKER`
- 处理：先确认终端焦点，再用短命令重试；必要时先做一次 `echo` 连通性探针

## 6. 记录要求

每次 handoff 相关问题至少记录：

- session 名、run_id、state_file
- 现象与时间点
- 修复动作
- 证据路径（`~/.gstack/webshell-runs/<run_id>/events.jsonl`）
