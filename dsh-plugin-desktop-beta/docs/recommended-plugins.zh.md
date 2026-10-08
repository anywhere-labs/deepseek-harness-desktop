# 精选实用插件清单

从 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（一个收录 4392 个第三方 DSH 插件的精选目录）中，按「实用性 + 采用度 + 权限面」三个维度，挑出一批真正值得日常使用的插件。

> 这些是**第三方插件**，不是桌面内置代码。它们通过市场或 CLI 安装到 Profile，安装后可独立「启用 / 禁用」（默认关闭，按需开启）。目录收录不代表安全审核，安装后即以用户权限作为本地代码运行，请按权限面自行判断。

## 候选清单

### 1. dsh-chat-import（session · 会话迁移）

- GitHub：<https://github.com/Nwflower/dsh-chat-import>
- 用途：从 13 个 coding agent（Claude Code、Codex、ChatGPT、Cursor、Gemini、opencode 等）导入完整对话历史，转为可续聊的 DSH 会话，并支持反向导出回 Claude Code。
- 采用度：downloads ≈ 4.3k
- 权限面：`fs-read` `fs-write` `network` `env` `dynamic-code`
- 适用：从其它 agent 迁入 DSH、需要保留历史上下文的用户。

### 2. dsh-agent-teams（workflow · 多智能体）

- GitHub：<https://github.com/NanmiCoder/dsh-agent-teams>
- 用途：多智能体团队编排（AgentTeams）。
- 采用度：stars ≈ 573 / downloads ≈ 10.5k（目录内真实采用度最高之一）
- 权限面：`fs-read` `fs-write` `network` `subagent` `llm`
- 适用：需要把任务拆给多个专业子代理协作的用户。

### 3. dsh-auto-memory（memory · 主动记忆 / 上下文管理）

- GitHub：<https://github.com/Aik358/dsh-auto-memory>
- 用途：主动联想记忆 + Astra 式上下文管理：自动唤回、三层自动沉淀、技能固化、交接账本与 PLAN 白板跨窗口续接、水位感知自动适配模型窗口；本地 Markdown 存储、模型无关、零依赖。
- 采用度：downloads ≈ 3.8k
- 权限面：`fs-read` `fs-write` `network` `env` `shell`
- 适用：与桌面自带的上下文管理改造互补，追求跨会话记忆连续性的用户。

### 4. dsh-history（session · 会话历史查看）

- GitHub：<https://github.com/chenproton/dsh-history>
- 用途：列出当前会话全部已发送消息，支持倒序、文本过滤、一键复制、点击跳转定位（目标未加载时自动加载更早历史）。
- 采用度：downloads ≈ 3.6k
- 权限面：`fs-read` `fs-write`（权限面最小，风险最低）
- 适用：几乎所有用户，日常回顾/检索会话内容。

### 5. dsh-tool-lens（tools · 代码架构分析）

- GitHub：<https://github.com/trench-xinxin/dsh-tool-lens>
- 用途：确定性 AST 代码图谱与架构治理：调用链消歧、重构爆炸半径、循环依赖审计、领域切片、全栈 API 契约追踪。
- 采用度：downloads ≈ 3.3k
- 权限面：`fs-read` `fs-write` `network` `shell`
- 适用：做代码库级重构/架构治理的开发者。

### 6. dsh-turn-rewind（session · 对话 / 工作区回退）

- GitHub：<https://github.com/Anionex/dsh-turn-rewind>
- 用途：基于持久 Change Ledger 回退对话与工作区状态。
- 采用度：stars ≈ 83 / downloads ≈ 2.4k
- 权限面：`fs-read` `fs-write` `network` `env` `shell`
- 适用：需要撤销错误操作、回滚到某个历史节点的用户。

## 安装与启用

安装身份统一用 GitHub 仓库地址（目录内 `spec` 即 `github:owner/repo`）：

- 市场方式：DSH Desktop 内置市场「发现」视图搜索插件名 → 详情 → 安装。
- CLI 方式（在 Profile 内）：

  ```bash
  dsh plugin add github:Nwflower/dsh-chat-import
  ```

安装完成后，插件默认进入「已安装但未启用」状态；在设置 → 插件里按需开启（这就是「可选、默认不启用、config 按需开启」的落点）。

## 未收录的原因说明

以下「高采用度」条目被有意排除，供参考：

- 以 `/tree/main/` 形式挂在无关大仓库里的集成（如 volcengine/OpenViking、vectorize-io/hindsight、tt-a1i/archify 等），并非独立 DSH 插件。
- 权限面含 `credentials + network` 或 `postinstall` 运行代码的条目（如 dsh-config-manager、dsh-plugin-writing-guard、deepseek-harness-acp 等），风险偏高。
