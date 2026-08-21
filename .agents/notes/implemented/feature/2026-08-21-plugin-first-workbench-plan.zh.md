# Agent Note: 插件优先的工作台优化计划

Status: implemented

[English](2026-08-21-plugin-first-workbench-plan.md) | 中文

## Problem

AI Buddy 已经有一批官方质量的默认项：Code 预设、工作套件推荐、官方 MCP 设置、fail-closed 社区市场。Minke v0.2.0 展示了更强的离座工作台（Files、Terminal、Command Palette、本机模型、远程控制面）。若把这些能力直接写进 `dsh-plugin-desktop`，就会替换官方 Web slot、预装未审核代码，或关掉社区安装路径。产品需要一份计划：把可抄的 Host 能力做成插件，同时让官方默认保持可选。

## Decision

桌面壳只做薄 Host；能抄的产品面做成插件。

**不变量**

- 桌面功能分支不修改 `deepseek-harness/`。
- 兼容模式不得替换官方 layout、sidebar 或 conversation。
- 工作套件名单是推荐，不是安装白名单。市场和 `dsh plugin add` 保持开放。
- 不预装社区插件，不预置 MCP、钉钉或企微令牌。
- 桌面自有 Host 面默认关闭，并必须能和社区插件组合。
- 同一能力不要叠两个插件（两个钉钉 Stream、两个 sidebar）。
- 图形启动保持显式。构建、typecheck、测试和 Loader 冒烟保持无头安全。

**阶段 0 — 先落地当前栈**

合并已叠好的产品 PR，不扩范围：换品牌、文档、logo、工作套件、办公 IM 起点推荐。保留工作套件里已经写明的社区开放合同。

**阶段 1 — 工作台走社区插件**

不自研第一方 Files / Tabs / Diff IDE。工作台路径就是现有推荐：`dsh-better-sidebar` 和 `dsh-context`。窄屏可把 `dsh-web-mobile` 写成非默认的后续推荐。安装仍走市场或 CLI。

**阶段 2 — Command Palette 做成插件**

把 Command Palette（`Mod+K`）做成桌面可选 client 插件，或社区 client 插件。它占用 `shell.overlay`，调用已有托盘、profile、设置和会话命令。不得替换官方会话面。

**阶段 3 — 本机模型发现做成 Host 插件**

增加可选 Host 插件，发现 loopback 上的 OpenAI 兼容运行时（Ollama、LM Studio 等）。可以拉起尚未运行的受支持运行时。不得接管已经在跑的服务，也不得预置令牌。

**阶段 4 — 办公 IM 留在社区**

钉钉官方 Stream（`dsh-dingtalk-channel`）和企业微信官方智能机器人（`dsh-wecom`）保持为起点推荐。除非这些社区插件无法与当前钉死的 DSH family 组合，否则不实现第一方 IM 通道。若以后必须做桌面自有通道，默认关闭，使用官方平台 SDK，并且不把飞书或聚合插件加入黑名单。每个平台由用户只开一条活通道。

**阶段 5 — 数据目录迁移做成 Host 插件**

增加可选 Host 插件：预览并合并 Sessions、插件和设置，只有重启成功后才切换 DSH home。这补上 AI Buddy user-data 拆分留下的缺口。禁止静默迁移。

**阶段 6 — 远程控制面放最后**

只在阶段 2–4 之后，才考虑 Minke 式控制面：同步会话、文件和真实 Host PTY；不要投屏 Electron 窗口。已验证的私有入口可以是 Tailscale Serve over HTTPS。DSH 继续只听 loopback。远程默认关闭，且不得和办公 IM 放进同一里程碑。

**明确不做**

- 用桌面自有 Tabs 替换官方 Web 工作台。
- 把带 GitHub 认证的插件发现当成默认安装路径。
- Linux 安装包或 AppImage。
- 把上游 pin 更新和产品功能混在一次提交里。
- 教用户去掉 macOS 隔离属性来代替签名发行。

## Verification

每个阶段完成时必须同时满足：

- 触及的包通过 `corepack yarn typecheck` 和自有单元测试。
- 兼容模式仍保留官方 layout、sidebar 和 conversation。
- 不在工作套件名单里的社区插件仍可通过市场或 `dsh plugin add` 安装。
- 新增 Host 面默认关闭，且不携带密钥。
- Loader 冒烟保持无头。

## Alternatives considered

**把 Minke 的 overlay 抄进桌面包。** 能更快得到 Files、Terminal 和远程访问，但会替换官方 slot，把 AI Buddy 变成第二个封闭工作台。

**现在就做第一方钉钉和企微 Host 通道。** 会重复社区插件，并可能挡住后续社区 IM 包。

**把 Tailscale / PWA 和办公 IM 放进同一切片。** 两者都在解决「人离开座位」。一起做会拆散安全预算和产品叙事。

**预装推荐的社区插件。** 违反市场 fail-closed 合同和禁止静默安装的规则。

## Consequences

桌面继续作为窗口、托盘、更新、MCP 设置和打包运行时的官方 Host。抄来的工作台能力以插件形式到达，市场可以替换它们。官方默认只是起点，因此后续 Host 工作之后，社区插件仍然可用。

工作台 Host 现在在 `dsh-plugin-desktop/workbench`。兼容模式仍把官方 layout、sidebar 和 conversation 留在原位。Command Palette 占用 `shell.overlay`。本机模型发现、数据目录合并和远程控制面默认关闭，也不预置密钥。办公 IM 仍是社区推荐，不是第一方锁定。远程入口同步会话、文件和本机 shell，不把 Electron 窗口编码成像素流。DSH 仍只监听 `127.0.0.1`。
