# 升级 DSH 运行时（runtime）排障指南

[English](upgrading-runtime.en.md)

本页面向**已经在使用 DSH Desktop 或本地 Web 端、并自行升级 `@deepseek-ai/dsh` runtime（例如切到 `0.1.1-rc.2` 等预发布版本）** 的用户。如果你只是用桌面端自带的更新按钮、没有手动动过 `~/.dsh`，可以跳过本页。

> 说明：本页是社区维护的排障笔记，不是官方文档。文中提到的 [`dsh-upgrade-toolkit`](https://github.com/TOBYCAI/dsh-upgrade-toolkit) 是一个独立的开源工具，由社区作者维护，与本项目不存在隶属或背书关系。它把下面几类问题的可靠解法固化成了可复用脚本。

## 为什么会踩坑

DSH 的"共享安装（runtime）"和"桌面壳（Desktop App）"是**两套独立的版本**：

- **runtime** = `~/.dsh/runtime` 里的 `@deepseek-ai/dsh`，决定实际的 harness 行为、adapter API、插件兼容性。
- **壳** = `DeepSeek Harness.app`（Electron 包），启动时通过 `healProfilesModuleFallback` 把 `~/.dsh/profiles` 下的 `@deepseek-ai/*` 软链接指向 runtime。

问题出在：**壳更新可能静默覆盖 runtime**，而 **runtime 升级（尤其是 rc 预发布版本）会改变 adapter API**，导致旧插件或旧壳崩溃。典型现象见 [常见问题](faq.md) 与社区 Issue #448、#457。

## 三类高频问题

### 1. 壳更新后 runtime 被覆盖 / 版本错位

现象：明明升级过 runtime，重启桌面端后 `dsh --version` 又变回旧版；或桌面端和 Web 端读取的 runtime 不一致。

根因：壳的 heal 机制把 profiles 的包软链接指向壳**自带**的 runtime，而不是你钉死的共享 runtime。

解法：把共享 runtime 设为权威，让壳和 profiles 的软链接都解析到它。参考 [`pin-runtime.sh`](https://github.com/TOBYCAI/dsh-upgrade-toolkit/blob/main/bin/pin-runtime.sh)：

```bash
# 钉死 runtime 为权威（壳/Profile 软链 → runtime），壳更新后重跑即可
bash pin-runtime.sh
```

### 2. 升级到 rc 版本后，第三方插件报 `prepareCall is not a function`

现象：Web 端启动报 `registration.adapter.prepareCall is not a function`。

根因：`0.1.1-rc.2` 对 **adapter API 做了破坏性变更**——每个 LLM adapter 必须实现 `prepareCall(provider, model, signal)`。部分第三方插件（如 `@liustack/modlens` ≤ 3.23.0）尚未适配，会在加载时崩溃。**这是 rc 版本的普遍风险，不只是某一个插件。**

临时解法：给插件打 `prepareCall` 补丁并用 `pnpm patch` 固化，等上游发版后移除。补丁示例与完整步骤见 [`patches/modlens-prepareCall.md`](https://github.com/TOBYCAI/dsh-upgrade-toolkit/blob/main/patches/modlens-prepareCall.md)。

> 兼容性细节（哪些插件/版本不适配哪个 DSH 版本）见 [toolkit 的兼容性矩阵](https://github.com/TOBYCAI/dsh-upgrade-toolkit#兼容性矩阵插件--版本-vs-dsh-版本)。

### 3. 用插件管理器更新插件时，pnpm 被"安全删除守卫"拦截

现象：在 WorkBuddy 等带安全删除守卫的终端里启动 Web 端，用 plugin-manager 更新插件报：

```
ERROR [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":123,"threshold":50,...}
```

根因：宿主终端注入了 `CODEBUDDY_SAFE_DELETE_*` 环境变量，pnpm 在 install 收尾清理临时目录（含 123 个文件）时超过批量删除阈值，非交互式调用无法确认而中断。

解法：启动 Web 端前卸载这些守卫变量（见 [`dsh-manage.sh` 的 `web` 子命令](https://github.com/TOBYCAI/dsh-upgrade-toolkit/blob/main/bin/dsh-manage.sh)）：

```bash
env -u CODEBUDDY_SAFE_DELETE_BULK_GUARD \
    -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR \
    -u CODEBUDDY_SESSION_ID \
    -u CODEBUDDY_TOOL_CALL_ID \
    dsh web
```

## 一站式工具

[`dsh-upgrade-toolkit`](https://github.com/TOBYCAI/dsh-upgrade-toolkit) 把上述三类问题的解法整合成一个可复用的命令行工具：

| 命令 | 作用 |
| --- | --- |
| `pin-runtime.sh` | 钉死 runtime 权威，壳更新不再覆盖 |
| `dsh-manage.sh update` | runtime 升级（pnpm + registry 预检 + 重钉） |
| `dsh-manage.sh shell` | 桌面壳升级（GitHub Releases + 备份 + 替换） |
| `dsh-manage.sh web` | 启动 Web 端并卸载安全删除守卫 |
| `verify-heal.mjs` | 校验 heal 后关键包仍解析到 runtime |

> 该工具是**互补而非竞争**：它不修改 Desktop 源码，只在用户侧管理 runtime 与壳的版本关系。如果你只想用桌面端自带的更新，本页前三节的手工步骤也足够。

## 相关链接

- 社区 Issue [#448](https://github.com/anywhere-labs/deepseek-harness-desktop/issues/448)（rc.1 适配请求）
- 社区 Issue [#457](https://github.com/anywhere-labs/deepseek-harness-desktop/issues/457)（桌面端与 Web 端版本错位）
- [dsh-upgrade-toolkit](https://github.com/TOBYCAI/dsh-upgrade-toolkit)
