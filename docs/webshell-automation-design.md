# Webshell Automation Design v1 (SSO + Persistent Agent Runtime)

## 1. 文档目的

本文件作为本轮设计定稿，完整沉淀以下内容：

- 现状评估
- 目标与边界
- 方案选择与取舍
- 方案细化（架构、流程、数据落盘、迭代计划）
- 实际联调执行中的问题与解决方案（持续补充）

## 2. 背景与现状

## 2.1 业务诉求

目标是让 agent 能处理内部 SSO 保护的 webshell 链路（例如 security-webshell），并在浏览器里持续作业，体验尽量接近“本地终端开发”。

核心要求：

- 能稳定进入 SSO 后的 webshell 并持续执行命令
- 每一步动作低耦合、可读、可复用
- 全过程本地可追溯（命令、输出、状态、异常）
- 能按场景选择不同运行策略并长期维护

## 2.2 当前可用能力（gstack browse）

`browse` 作为底层浏览器引擎已具备关键基础：

- 持久会话与命名会话复用（`BROWSE_SESSION_NAME`、`sessions`、`session-kill`）
- SSO 相关入口能力：
  - 本机浏览器 cookie 导入（`cookie-import-browser`）
  - 人工接管/恢复（`handoff` / `resume`）
- Webshell 输出采集：
  - DOM 观察（`observe`）
  - websocket 帧观察（`websocket`）

结论：作为“浏览器基础设施”是够的。

## 2.3 当前缺口

缺口不在浏览器底层，而在 webshell 运行时编排层：

- 缺少一等公民 `webshell run` 抽象（状态机、生命周期、场景策略）
- 缺少统一命令级账本（command intent -> submit -> output -> settle -> result）
- 终端选择器发现依赖临时 heuristic，缺少可维护 adapter profile
- 缺少风控门控与确认策略统一层（safe/review/blocked）

## 2.4 约束与工程上下文

本轮在独立 worktree 中推进：

- `gstack` worktree: `/Users/bytedance/gstack_worktrees/session-20260327-webshell-agent`
- `ai_dev` worktree: `/Users/bytedance/ai_dev_worktrees/session-20260327-webshell-agent`

关联约束：

- 需要满足“本地可追溯”和可归档要求
- 需支持 SSO 场景下自动与半自动（人工接管）混合流程

## 3. 目标与非目标

## 3.1 目标

1. 给定内部 SSO webshell URL，agent 能进入并执行远端 Linux 命令。
2. 支持长会话持续运行，不因单次步骤失败丢失上下文。
3. 每条命令均可回放：输入、输出证据、状态、错误、处置记录。
4. 支持按场景自动选择运行策略。

## 3.2 非目标（当前阶段）

- 不替换 `browse` 底层传输模型（仍用本地 daemon + command）
- 不建设云端控制面
- 不追求对所有企业 SSO 流程 100% 全自动（保留 handoff fallback）

## 4. 方案选型与决策

## 4.1 候选方案

### 方案 A：沿用 browse，新增 webshell runtime 层（推荐）

优点：

- 复用现有成熟能力（会话、cookie、handoff、observe/websocket）
- 实施成本低，迭代快
- 与当前 gstack 生态一致，风险最小

缺点：

- 需要新增编排层代码与文档规范

### 方案 B：替换底层浏览器引擎（Puppeteer/Selenium/MCP）

优点：

- 理论上可按新范式重构

缺点：

- 迁移成本高，收益不确定
- 需要重做现有会话与工具链整合
- 本轮目标交付风险高

### 方案 C：双通道（浏览器 + 直连协议）

说明：浏览器负责 SSO 和兜底；命令执行优先走 SSH/API。

优点：

- 中长期稳定性上限更高

缺点：

- 当前依赖后端条件，不适合作为第一阶段主路径

## 4.2 决策

本阶段采用 **方案 A**：保留 `browse` 底层，构建 `webshell runtime` 编排层。  
同时在架构上为方案 C 预留扩展接口（后续可接入直连执行器）。

## 5. 方案细化

## 5.1 运行时核心抽象：Webshell Run

每次会话对应一个 `run_id`：

- `run_id`
- `session_name`
- `target_url`
- `scenario_profile`
- `auth_mode` (`cookie_import` | `handoff_resume`)
- `terminal_profile`
- `risk_mode`
- `state`

状态流：

`init -> auth -> ready -> executing -> paused -> completed|failed`

## 5.2 鉴权状态机

固定流程：

1. `goto target_url`
2. `cookie-import-browser`（优先）
3. `auth verify`
4. 未通过则 `handoff` / 用户完成后 `resume`
5. 再次 `auth verify`

每一步写事件日志，禁止隐式跳步。

## 5.3 Terminal Adapter 层

针对不同 webshell UI 建立 profile：

- `input_selector`
- `output_selector`
- `submit_action`（Enter / button / custom）
- `completion_policy`（stable_ms / prompt regex / ws quiet）
- `capture_mode`（dom_first / ws_first / hybrid）

目标：把站点差异从执行流程中剥离。

## 5.4 命令执行单元（低耦合）

每条命令统一拆成：

1. `prepare`：聚焦输入控件
2. `submit`：输入并发送命令
3. `observe`：DOM 或 websocket 增量采集
4. `settle`：等待稳定或超时
5. `record`：写命令账本与证据索引

## 5.5 风险门控

命令提交前做风险分类：

- `safe`：自动执行
- `review`：要求用户确认
- `blocked`：默认拒绝，仅显式 override 放行

## 5.6 场景策略

- `sso_cold_start`：首次 URL，cookie 优先，handoff 兜底
- `warm_resume`：复用历史 session，快速健康检查
- `ws_heavy_terminal`：websocket 作为主采集
- `high_risk_ops`：强门控与确认
- `long_running_batch`：分段 checkpoint 与汇总归档

## 6. 落盘与可追溯设计

每个 run 目录：`.gstack/webshell-runs/<run_id>/`

- `run.yaml`：run 元信息与当前状态
- `events.jsonl`：状态迁移、关键动作、异常
- `commands.jsonl`：每条命令（intent/raw/risk/confirm/result）
- `observations/`：DOM delta、ws tail、截图
- `artifacts/summary.md`：人工可读总结

设计要求：

- 所有执行动作必须可回放
- 所有失败必须可定位到具体步骤与证据

## 7. 迭代计划

## M1（基础账本）

- 建立 run/event/command/observation 存储
- 不改变 browse 现有命令语义

## M2（鉴权状态机）

- 把 cookie+handoff+verify 串成显式状态流

## M3（adapter + 执行单元）

- profile 化终端交互
- 命令执行进入标准五段式

## M4（场景路由）

- 根据 URL/历史状态/风险模式自动选策略

## M5（风控+测试+文档）

- 风险门控规则
- 场景回归
- 运行手册

## 8. 验收标准

1. 给定 SSO URL 能完成登录并进入 webshell（可自动或 handoff）。
2. 能在远端执行命令并稳定采集输出。
3. `/var/log/tiger` 类批量读取任务可一次完成并完整留痕。
4. 全过程有可审计 run 目录。
5. 遇到失败有结构化问题记录与对应解决策略。

## 9. 联调记录（本轮持续更新）

> 本节用于记录“执行过程中遇到的问题和解决方案”，用于反哺设计。

### 9.1 问题：沙箱内无法绑定本地端口，browse server 启动失败

- 现象：`No available port after 5 attempts in range 10000-60000`
- 根因：当前运行环境对本地 socket bind 有限制（`Operation not permitted`）
- 解决：对 `browse` 切换为提权运行（outside sandbox）
- 设计改进：运行时需在 preflight 增加“port bind capability check”，失败自动切换执行模式并记录

### 9.2 问题：可能出现会话锁等待超时

- 现象：`Another instance is starting the server, waiting... Timed out`
- 根因：并发启动或残留锁导致等待
- 解决：固定 `BROWSE_SESSION_NAME` + preflight 清理 stale lock + 单 run 串行启动
- 设计改进：增加 run 级互斥锁与锁过期策略

### 9.3 待补充

- 将在本轮 webshell 实操后补充 SSO、terminal selector、输出采集等实际问题与解法。

### 9.4 问题：浏览器 cookie 自动导入失败（Comet keychain 不可用）

- 现象：`No Keychain entry for "Comet Safe Storage"`
- 根因：当前环境未检测到可用 Comet key链条目/浏览器类型不匹配
- 影响：cookie 导入链路不可作为唯一 SSO 路径
- 解决：回退到 `handoff/resume` 人工登录路径
- 设计改进：
  - auth state machine 必须把 cookie import 视为“可选快速路径”
  - 失败后自动进入 handoff，且记录 `auth_fallback_reason`

### 9.5 问题：页面 200 但 DOM 为空，无法定位 terminal 元素

- 现象：`goto` 返回 200，`snapshot/text/forms/js(title)` 均近似空输出
- 可能根因：
  - SSO 未完成导致中间态页面（脚本渲染但未激活）
  - 目标系统依赖额外上下文（cookie/二次跳转）
  - 页面主要内容在 iframe 或延迟注入阶段
- 当前处理：
  - 记录为 `auth_or_render_incomplete`
  - 不盲目执行终端命令，先要求明确登录完成再继续
- 设计改进：
  - 增加 `readiness_probe`：title/body length/terminal selector/iframe scan 多信号判定
  - 未 ready 时禁止进入 `executing` 状态

### 9.6 本轮执行结论（2026-03-27）

- 设计文档已完成并落盘。
- URL 可达（HTTP 200），但当前会话未取得可执行 webshell 的“ready”状态证据。
- 因未能确认 terminal 输入输出通道，`/var/log/tiger` 命令执行暂未进行，避免产生假结果。

### 9.7 问题：`websocket --since` 输出尾部控制行污染结果（`NEXT_SINCE`）

- 现象：命令输出偶发夹带 `NEXT_SINCE N`，影响日志正文抽取。
- 根因：采集脚本在分段时未显式剥离 `websocket --since` 的 cursor 尾行。
- 解决：在 `scripts/webshell_latency_probe.py` 中新增 `strip_next_since_suffix`，并修正帧头正则，确保只拼接 `in` 方向 payload。
- 结果：`/tmp/webshell_tiger_tail_full_v4.json` 中 `bad_count=0`（无 `NEXT_SINCE`、无 `TIMEOUT_NO_END_MARKER`）。

### 9.8 问题：会话存在但实际 URL 回退到 `about:blank`

- 现象：`status` 显示 healthy，但 `url=about:blank`，直接执行远端命令会超时。
- 根因：原会话 server 发生重启/切换后，页面上下文已丢失，未重新完成 readiness。
- 解决：执行前强制 preflight：
  1. `auth-load`
  2. `goto <target_url>`
  3. `url/status` 校验
  4. 发送 `echo __WS_READY__` 烟测
- 设计改进：将 `ready_probe` 作为执行前强制门禁，不满足则禁止批处理命令进入执行阶段。

### 9.9 本轮实测结果（2026-03-31）

目标 URL：

- `https://security-webshell.byted.org/common/v2?from=bernard&state={...container_id=bf74df...}`

鉴权与会话：

- `auth-status`: `present`（`/Users/bytedance/.gstack/browse-auth-state.json`）
- `auth-load` 后可直接 `goto` 目标 URL（HTTP 200）
- 无需重复人工 SSO 弹窗授权

执行与产物：

- 通过 websocket 增量 cursor（`--since`）+ begin/end marker 完成全量批处理
- `/var/log/tiger` 文件数：`175`
- 每个文件执行：`tail -n 5 /var/log/tiger/<file>`
- 结构化报告：`/tmp/webshell_tiger_tail_full_v4.json`
- 可读汇总：`/tmp/webshell_tiger_tail_last5_v4.txt`

性能统计（来自 v4 报告）：

- `count=175`
- `avg_input_to_result_ms=233.64`
- `avg_send_to_result_ms=128.02`
- `avg_polls=1.56`

### 9.10 设计结论更新（覆盖 9.6 的阶段性结论）

- 当前链路已具备“SSO 缓存复用 + webshell 持续执行 + 增量可追溯输出”的可用能力。
- `browse` 作为底层浏览器能力仍然成立；核心建设重点应继续放在 runtime 编排层（状态机、adapter、账本、场景路由）。
- 增量 cursor 机制已验证可显著提升交互效率与结果边界清晰度，可作为默认读取策略。


### 9.11 问题：marker 被终端回显污染，命令输出被误解析

- 现象：命令返回内容不是实际 stdout，而是回显的 wrapper 片段（例如 \`\n'; echo __WS_READY__; printf '\n\`）。
- 根因：旧解析逻辑只依赖“最后一个 begin marker”，会把 terminal echo 的 marker 对误当成真实结果。
- 解决：
  - 新增混合解析策略：从尾部反向找完整 \`BEGIN...END\` 对。
  - 增加 echoed-wrapper 识别规则，命中后跳过该 marker 对，继续回溯上一对。
  - 同时兼容 clean payload 与 mixed payload。
- 验证：新增测试 \`webshell cmd ignores echoed wrapper marker pair and captures real output\`，并在真实 URL smoke 中验证 \`echo __WS_READY__\` 返回正确。

### 9.12 问题：状态文件路径不一致导致会话复用不稳定

- 现象：同一 run 已 ready，但后续命令偶发重新起 server，导致 URL/上下文丢失。
- 根因：不同调用路径使用了不同 \`BROWSE_STATE_FILE\`（会话路径与默认路径混用）。
- 解决：
  - 本轮 smoke 统一走单一路径（默认 \`~/.gstack/browse.json\`）。
  - 若需要命名会话，必须保证所有命令固定同一 \`BROWSE_STATE_FILE\`。
- 设计改进：建议在 run 元信息中显式记录 \`state_file\` 并在 \`webshell status\` 输出，避免诊断歧义。


## 10. 实现落地（2026-03-31）

本轮已把设计从文档落地到 `browse` 主命令面，新增 `webshell` 子系统并保留低耦合命令粒度。

### 10.1 新增命令面

- `browse webshell start <url> [run_id]`
- `browse webshell preflight <run_id> [url]`
- `browse webshell status <run_id>`
- `browse webshell cmd <run_id> [--confirm] -- <command...>`
- `browse webshell set <run_id> <key> <value>`
- `browse webshell list`
- `browse webshell finish <run_id>`

### 10.2 运行时抽象与落盘

新增运行时模块：`browse/src/webshell-runtime.ts`。

每个 run 固定目录：`~/.gstack/webshell-runs/<run_id>/`，包含：

- `run.json`：当前状态快照
- `events.jsonl`：状态机事件
- `commands.jsonl`：命令级账本（含 ms 耗时）
- `observations/cmd-XXXX.log`：命令输出证据

### 10.3 关键机制

- preflight 强制执行：`auth-load(若可用) -> goto -> readiness_probe -> cursor reset`
- 增量读取：以 websocket buffer cursor 做 `since_start/since_end` 边界
- 风险门控：高风险命令默认 `review`，需 `--confirm`
- about:blank 门禁：阻止误执行并要求重新 preflight

### 10.4 对已知问题的代码级对应

- `NEXT_SINCE` 污染问题：通过独立脚本修复并验证（`scripts/webshell_latency_probe.py`）
- 会话回退到 `about:blank`：`webshell cmd` 前置状态校验 + 错误提示
- 可追溯要求：所有命令均落 `commands.jsonl` 与 `observations/*.log`

### 10.5 配置扩展

新增配置项：

- `BROWSE_WEBSHELL_RUN_ROOT`（默认 `~/.gstack/webshell-runs`）

并在 `ensureStateDir` 中统一创建 `stateDir/authDir/webshellRunRoot`。
