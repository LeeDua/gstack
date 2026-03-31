# Webshell Agent Interaction Spec v1

## 1. 目标

约束 agent 在 SSO+webshell 场景下的交互风格，确保：

- 单条命令低耦合、可读、可审计
- 需要用户确认的场景边界清晰
- 默认自动化路径稳定，不打断用户

## 2. 命令粒度规范（短命令）

每一步尽量只做一件事；禁止把过多动作塞进一条命令。

- 推荐：每条命令 <= 1 个核心动作
- 允许：最多 5 个紧密相关子动作
- 禁止：长链路混合（鉴权+导航+批处理+汇总）

推荐拆分模式：

1. `webshell start/preflight`
2. `webshell status`
3. `webshell cmd -- <single command>`
4. `webshell cmd -- <next command>`
5. `webshell finish`

## 3. 默认执行策略（减少询问）

以下场景默认不询问用户，直接执行：

- `browse` / `gstack` 相关常规命令
- 已知安全命令（读操作、状态查询、日志查看）
- 同一 run 内的连续诊断步骤
- 已存在 auth state 的自动复用（`auth-load`）
- 用户在当前会话已明确预授权的 webshell 操作（本会话：不逐条询问）

原则：若可以通过已有上下文安全决策，则不打断用户。

## 4. 必须询问用户的场景

仅以下情况需要询问：

1. 高风险命令
- 命中 risk 分类 `review`（如 `rm -rf`, `mkfs`, `shutdown`, `reboot`, `DROP/TRUNCATE`, `kubectl delete`, `terraform destroy`）
- 默认需要显式 `--confirm` 或用户确认后再执行
- 例外：如果用户已在会话中明确给出“webshell 操作不逐条授权”的预授权，可直接执行并在 run ledger 记录

2. 不可逆/破坏性动作
- 任何会修改远端关键状态且不可回滚的操作

3. 意图歧义
- 用户目标不明确，且错误执行代价高

4. 权限边界变化
- 需要超出既有授权范围（例如新增外部系统权限）

## 5. 运行时可追溯要求

每个 run 必须落盘：

- `run.json`：状态与配置
- `events.jsonl`：关键事件与异常
- `commands.jsonl`：命令与毫秒级耗时
- `observations/cmd-XXXX.log`：命令输出证据

命令级最小字段：

- `command`, `risk`, `confirmed`
- `since_start`, `since_end`
- `input_to_result_ms`, `send_to_result_ms`, `poll_count`
- `timed_out`, `no_websocket_activity`

## 6. 增量读取规范

默认使用 websocket 增量游标，避免 tail 窗口回读：

- 读取：`websocket --since <cursor>`
- 响应必须携带：`NEXT_SINCE <cursor>`
- 下一次从 `NEXT_SINCE` 继续

禁止同时使用 `--tail` 和 `--since`。

## 7. 失败处理与降级

1. `about:blank` 或 run 非 `ready`
- 自动 preflight 一次
- 仍失败则给出可执行下一步，不做盲执行

2. marker 解析异常
- 跳过 echoed wrapper marker 对
- 回溯上一个有效 `BEGIN...END`

3. 超时
- 记录 `TIMEOUT_NO_END_MARKER`
- 不隐式重试高风险命令

## 8. 输出风格

返回给用户的执行反馈应包含：

1. 执行了什么命令
2. 状态（ready/failed）
3. 关键耗时（ms）
4. 输出证据路径
5. 若失败：根因与下一步建议

避免一次性刷屏超长结果；大输出以文件路径为主，必要时附摘要。
