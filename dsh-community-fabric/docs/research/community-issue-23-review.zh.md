# 社区 Issue #23：意见审查与处置记录

[English](community-issue-23-review.md) | 中文

| 字段 | 内容 |
| --- | --- |
| 来源 | [omdsh-dev/community issue #23](https://github.com/omdsh-dev/community/issues/23) |
| 快照 | 2026-08-17；Open；13 条评论；没有 milestone，也没有已通过的正式规范 |
| 目的 | 记录哪些意见修改了 Fabric Draft、哪些需要独立 RFC、哪些不属于可移植核心 contract |

## 0. 一句话结论

Issue #23 是很有价值的设计输入，但还不是已经通过的社区标准。评论指出了原提案中的四个重要缺口：

1. Runtime、Presentation、Control、Transport 与当前 Invocation 是不同职责；
2. 插件除了 capability 判断，还需要确定性的 service provider 组合规则；
3. 兼容性需要机器可读验证和运行时 ownership 证据；
4. 从私有 patch 迁移需要 Adapter 策略，但不能把 patch 变成公共插件 API。

Fabric 文档现在通过强化后的 [RFC 0001](../rfcs/0001-plugin-manifest-capabilities-events.zh.md)和三份聚焦的后续 Draft 吸收这些意见：

- [RFC 0002：Runtime、Presentation、Control、Transport 与 Invocation](../rfcs/0002-runtime-presentation-invocation-transport.zh.md)；
- [RFC 0003：Service Provider 与组合规则](../rfcs/0003-service-providers-and-composition.zh.md)；
- [RFC 0004：溯源、验证、诊断与 Effect Ledger](../rfcs/0004-provenance-validation-and-diagnostics.zh.md)。

这些文档都没有声称 runtime、SDK、正式 schema 或兼容认证已经实现。

## 1. 如何标记处置结果

| 结果 | 含义 |
| --- | --- |
| 已采纳 | 当前 Fabric Draft 已包含这项要求。 |
| 限定采纳 | 接受真实需求，但缩小了不安全或过宽的实现范围。 |
| 独立 RFC | 方向有价值，但在成为可移植 API 前需要独立 contract、证据和审查。 |
| Adapter 实验 | 固定版本的实现可以在 DSH Adapter 边界内探索；插件不能把它当成稳定 Fabric API。 |
| 不属于可移植核心 | 它可以属于某个产品或 UI，但不是跨 Host 的 Fabric 必选要求。 |
| 已记录 | 为了可追踪性保留输入链接，但它本身不会产生规范变化。 |

“已采纳”只表示被这些 Draft 文档采纳，不表示 Issue #23 的参与者已经形成正式共识。

## 2. 逐条意见处置

| 社区意见 | 处置 | Fabric Draft 中的结果 |
| --- | --- | --- |
| [`plugin.json` 与 Agent Plugins 规范冲突](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305622804) | 已采纳 | Fabric 使用不会混淆的根文件名 `dsh-plugin.json`，并保持静态文档。 |
| [借鉴 Kubernetes 的 type metadata 和带版本 service/event](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305636433) | 限定采纳 | Schema identity、Fabric API version、capability version、Host Descriptor version、plugin version 与 event type version 是不同维度；Fabric 不会照搬整套 Kubernetes resource 语义。 |
| [Patch/版本震荡与可信验证需求](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305638423) | 已采纳 | RFC 0004 区分收录、声明、实测、签名证明和强制隔离。格式检查通过绝不能展示成“安全”。 |
| [多 Panel Web UI 的 URL query state](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305642357) | 不属于可移植核心 | Deep link 与 URL state 规范属于 Web Presentation capability，不能要求 TUI、原生 GUI 或 headless Runtime 实现。 |
| [安装前影响预览与运行时溯源](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305656025) | 已采纳 | RFC 0004 定义安装影响报告、验证报告、activation ownership，以及带清理诊断的 Host 观测 effect ledger。 |
| [dsh-forge / dsh-neoforge 运行时 mixin PoC](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305908558) | Adapter 实验 | 当前的 [dsh-neoforge 概念验证](https://github.com/r05En1cU/dsh-neoforge) 为显式冲突检测、可恢复 ownership 和 lifecycle cleanup 提供了有价值的证据。运行时方法替换仍然只是固定版本的实验性 DSH Adapter 技术；manifest 不能携带可执行 mixin 指令，插件也不能把私有 target 当作可移植 API。 |
| [静态验证、Schema/API 分版、capability registry、contribution ID、迁移信息和验证报告](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306132230) | 限定采纳 | RFC 0001 要求静态 JSON、明确 Schema 选择、权威机器可读 registry 与确定性 contribution identity。RFC 0004 定义报告证据和只读 `legacyEffects` 诊断段；声明 legacy effect 永远不会授权执行。 |
| [dsh-TUI 作为早期一致性实现](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306241618) | 限定采纳 | 欢迎真实 TUI 证据，并要求 headless conformance；但任何实现都不能因为主动认领就自行认证。可修改的 `before-*` 拦截仍不进入 v0.1，直到顺序、timeout、取消、隐私和审计语义被定义。 |
| [Remote SSH 反例、command tree、invocation capability 与 ephemeral presentation](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306386927) | 独立 RFC | RFC 0002 拆分 Runtime、Presentation、Control、Transport 和 Invocation。Presentation capability 随每次 invocation 传递；command tree 和非持久 presentation message 是 Draft 的一等 contract，而不是 TUI 私有 metadata。 |
| [Reference Host 与可 attach 的 Runtime/Presentation 模型](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306670321) | 限定采纳 | RFC 0002 定义分层和 conformance 场景。Fabric 会提供参考组件和测试套件，但不会指定唯一产品架构，也不会要求具体 SSH/WebSocket transport。 |
| [依赖锁定、复现与环境可观测性](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306757296) | 独立 RFC | RFC 0004 记录不可变 artifact 与环境证据。完整 lockfile、modpack、迁移、回滚和可复现 workspace 分发仍属于后续 packaging/distribution 提案。 |
| [`requires` / `provides` / `contributes` 与确定性组合](https://github.com/omdsh-dev/community/issues/23#issuecomment-5307228009) | 已采纳 | RFC 0003 定义 provider cardinality、用户选择、冲突计划、替换、健康状态和 lifecycle ownership；加载顺序不是仲裁机制。 |
| [指向扩展后的 Fabric 调研与 Draft](https://github.com/omdsh-dev/community/issues/23#issuecomment-5308979722) | 已记录 | 本审查把每项社区关注点关联到具体 Draft 或明确的延期决定，闭合反馈链路。 |

## 3. 仍然刻意保持严格的决定

### 3.1 v0.1 不做按需激活

Fabric v0.1 在协商后执行 generation-scoped eager activation。按需激活会引入第二套生命周期、首次并发竞态、延迟失败和更难验证的清理；以后可以基于测量结果和完整状态机单独提案。

### 3.2 v0.1 不开放可修改的 `before-*` 事件

第一种事件只允许不可修改的观察。修改或取消 hook 必须定义参与者顺序、冲突规则、deadline、backpressure、错误隔离、replay、payload privacy 与审计记录。给普通 listener 加上 `before` 名字并不能解决这些要求。

### 3.3 Capability 声明不是沙箱

同进程内受信任的 Node.js 插件可以绕过提供的 context，直接 import 操作系统模块。Fabric 可以在自己的 API 边界校验、协商、记录和拒绝不支持的调用；只有使用受管 import 与 IPC 的隔离执行档位，才能声称技术强制。

### 3.4 Legacy 兼容由 Adapter 负责

Fabric 管理的插件使用公共 contract。经过审查的 DSH Adapter 可以临时把稳定 contract 映射到固定版本的私有 seam，但不能把 seam 暴露给插件作者。上游发生变化时，Adapter 必须适配、降级或拒绝激活，不能要求每个插件重新 patch 新 target。

### 3.5 产品可以在迁移期保留旧加载方式

Fabric 可以禁止 Fabric-managed plugin 绕过标准加载，但不能声称所有 DSH 产品立刻删除现有 Cordis/plugin/profile 路径。兼容模式和非 Fabric 插件在迁移期仍然是明确的产品边界。

## 4. 下一步应该实现什么

下一轮实现应继续小于完整愿景，并明确分开 v0.1 关键路径与后续实验。

### 4.1 实验性 v0.1 关键路径

1. 冻结 Draft manifest Schema、Host Descriptor Schema、capability registry 和 event envelope；
2. 实现不依赖 DSH 的纯 manifest/Host-capability negotiator；
3. 实现拥有 registration、activation lifetime 和最小 transition ledger 的 Broker 原型；
4. 实现一个固定版本的 DSH Adapter，并把它观测的 effect 与真实 DSH registration 对比；
5. 发布 supported、degraded、conflicting、cancelled 和 incomplete-cleanup 的 headless fixture；
6. 从至少两个 Host integration 收集 v0.1 结果，但不把任何一个实现当成标准本身。

v0.1 negotiator 只覆盖 RFC 0001 实际支持的 Host capability 和声明，不会激活 plugin-provided service，也不会宣称实现 RFC 0002–0004 提议的 post-v0.1 extension。

### 4.2 并行与 v0.1 之后的探索

- RFC 0002 可以用一个 Runtime 同时连接两个 Presentation descriptor，确保 Remote SSH 假设会在测试中显式失败。
- RFC 0003 可以先实现纯静态 service-composition planner，再考虑任何 runtime Provider binding。
- RFC 0004 可以在规范 v0.1 transition ledger 之上验证安装报告和物化诊断。
- TUI、Web UI 与 Desktop 都可以贡献证据，但任何单一产品都不会成为标准本身。

UI 渲染语言、强沙箱、package distribution、市场签名证明、可修改拦截与完整可复现性必须保持为独立里程碑。

## 5. 这份记录如何更新

这是对链接 Issue 快照的日期化审查。新评论不会静默改写 Draft。重要变化应先通过审查更新对应 RFC，再在本记录中补充评论链接、处置和受影响 contract。
