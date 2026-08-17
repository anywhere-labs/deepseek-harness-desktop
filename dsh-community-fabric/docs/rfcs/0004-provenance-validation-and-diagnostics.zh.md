# RFC 0004：溯源、验证、诊断与 Effect Ledger

[English](0004-provenance-validation-and-diagnostics.md) | 中文

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft / 征求意见 |
| 目标 | 扩展 v0.1 最小 ownership ledger 的横切 contract |
| 范围 | 安装影响、运行时 ownership、验证证据、清理诊断 |
| 依赖 | [RFC 0001](0001-plugin-manifest-capabilities-events.zh.md) |
| 社区输入 | [omdsh-dev/community issue #23](https://github.com/omdsh-dev/community/issues/23) |

## 0. 一句话摘要

Fabric 必须能在不猜测的情况下回答四个问题：

1. 这个插件声称会添加或修改什么？
2. Host 实际允许并激活了什么？
3. 当前可见的 command、service、UI、process、route 或其他 effect 属于哪个插件？
4. 停用、替换或卸载之后，哪些内容已经清理，哪些仍然残留？

本 RFC 提议三种机器可读产物：安装影响报告、验证报告和由 Host 观测的运行时 effect ledger。它们让兼容性和故障可以解释，但不会把不受信任的本地代码变成安全代码。

## 1. 背景

Manifest 校验只能证明 JSON 结构符合预期。目录收录也只能证明某个来源提供了元数据。二者都无法解释 package script、native dependency、授权、共享 service 冲突、运行时注册或清理结果。

社区在[这条评论](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305656025)中明确区分了安装前影响预览和运行时溯源。验证工具相关讨论也在[这条评论](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306132230)中提出统一机器可读报告，而不是让每个 Host 输出自己的自然语言。

RFC 0001 已要求 activation-scoped ownership，以及 v0.1 中最小的 append-only transition ledger。本 RFC 在这个基础上扩展安装、验证、物化诊断、保留与恢复语义。以后再尝试从普通日志还原 ownership 会不完整且不可靠。

## 2. 目标

- 区分插件/provider 声明、包管理器观测、Host 决策和运行时观测。
- 把每份报告绑定到不可变的插件 artifact identity。
- 在执行任何 package 代码前预览有意义的安装影响。
- 为每个 Fabric 管理的运行时 effect 记录插件与 activation ownership。
- 为 Host、CI、启动器和市场提供稳定验证结果与 reason code。
- 解释冲突、替换、激活失败、清理不完整和残留状态。
- 在不泄露用户内容或 secret 的前提下，保留足够证据复现经过测试的组合。

## 3. 非目标

- 定义通用恶意代码扫描器，或把通过报告称为“安全”。
- 替代代码签名、沙箱、操作系统策略或人工审核。
- 在本 RFC 中统一所有包管理器和 lockfile。
- 把目录热度、stars、publisher claim 或合作来源当成验证。
- 仅因为声明了 legacy effect 就获得 patch 私有代码的权限。
- 要求报告包含原始消息、credential、本地路径或环境变量。

## 4. 证据类型

报告中的每个字段都有 evidence class，UI 不能把一种类型静默升级成另一种。

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| `declared` | 由插件 manifest 或 publisher 提供。 | 申请的 capability、声明的 repository。 |
| `resolved` | 包管理器或 resolver 根据不可变输入推导。 | 精确 package 版本、依赖图、artifact digest。 |
| `decided` | 由 Host policy 或用户选择。 | 已授权 scope、选中的 provider、拒绝的 build script。 |
| `observed` | Broker 或 Adapter 在运行时记录。 | 注册的 command、启动的 process、清理结果。 |
| `tested` | 由具名测试套件在明确环境中产生。 | Host conformance 用例在 win32-x64 通过。 |
| `attested` | 由可识别的 verifier 签名。 | 未来的签名验证声明。 |

`attested` 只说明谁签署了声明，不代表该声明天然可信。签名与信任策略仍然分开。

## 5. 不可变 subject identity

报告绝不能只绑定可变 package 名、branch、URL 或 `latest` 标签。Subject 至少包含：

- Fabric plugin ID 和插件版本；
- 适用时的 package ecosystem 与精确 package 版本；
- 适用时的规范 source identity 与不可变 repository commit；
- 被检查 artifact 的加密 digest；
- manifest Schema 标识与 Fabric API range；
- 安装产生不同可执行 artifact 时的可选 build-output digest。

Artifact digest 改变后，旧报告不再适用。Host 可以展示相关历史证据，但必须明确标记为 stale。

## 6. 安装影响报告

安装影响报告在安装确认前生成，输入包括 manifest、package metadata、已解析依赖计划和 Host policy。它不包含目录提供的可执行命令。

至少记录：

- 精确 subject identity 与来源声明；
- 直接和间接 package dependency，并标记 native addon；
- 可能运行的 lifecycle/build script；
- 申请的 Fabric capability、permission 与 scope；
- 声明的 contribution、provided service 与 subscription；
- 将新增、修改或移除的 profile/composition 记录；
- 预期文件、storage namespace、network origin、process 和 secret，以稳定 scope 而不是原始本地路径表示；
- 冲突、需要用户选择、缺失 capability 和 restart 要求；
- 检测到的 legacy patch/mixin/override target，并明确标为不可移植 effect。

静态检查可能不完整。每个字段都带 `complete`、`partial`、`unknown` 或 `not-applicable`；缺少证据绝不能显示成“没有影响”。

最终确认界面展示有界的产品摘要，并可以打开详细报告。只有安装目标不可变、且报告与所选 profile 和 Host policy 仍然匹配时才能继续。

## 7. 验证报告

验证报告是交换格式，不是单一 boolean。讨论用结构如下：

```json
{
  "schemaVersion": "0.1.0",
  "reportId": "urn:uuid:...",
  "subject": {
    "pluginId": "com.example.plugin",
    "version": "1.2.0",
    "digest": "sha256:..."
  },
  "standard": {
    "apiVersion": "0.1.0",
    "manifestSchema": "https://example.invalid/fabric/manifest/0.1.0"
  },
  "validator": {
    "id": "org.example.fabric-verify",
    "version": "0.3.0"
  },
  "environment": {
    "hostDescriptorDigest": "sha256:...",
    "platform": "linux-x64",
    "trustMode": "trusted-in-process"
  },
  "suite": {
    "id": "fabric-plugin-validation",
    "version": "0.1.0",
    "commit": "..."
  },
  "startedAt": "2026-08-17T00:00:00Z",
  "outcome": "pass",
  "checks": []
}
```

每项 check 包含稳定 ID、版本、结果（`pass`、`fail`、`warning`、`skipped`、`unknown`）、evidence class、reason code 和脱敏诊断。只要 required check 失败或被静默省略，aggregate outcome 就不能是 `pass`。

首批报告类型应彼此分开：

- Manifest 与 package validation；
- Host conformance；
- plugin contract validation；
- plugin × Host interoperability evidence；
- 安装影响检查；
- 运行时清理诊断。

市场和启动器可以消费这些报告，但必须展示 verifier、artifact digest、环境、时间以及 stale/revoked 状态。`listed`、`declared compatible`、`tested`、`attested` 与 `sandbox-enforced` 始终是不同标签。

## 8. 运行时 Effect Ledger

规范 ledger 是一组 append-only、不可修改的 transition record。它的 v0.1 最小模型与 RFC 0001 完全相同：

- `ledgerVersion`、`recordId`、单调递增 `sequence` 与 `recordedAt`；
- owner `pluginId`、`pluginVersion` 或 `manifestDigest`、`activationId` 与 `runtimeId`；
- `effectId`、`effectKind`、规范 contract ID/version，以及存在时的稳定 `resourceId`；
- `operation` 与结果 `state`，至少包含 `create`、`bind`、`replace`、`release` 和 `cleanup-failed`；
- 可选 `correlationId`、旧/新 owner 或相关 effect ID，以及不敏感的 `outcome` 或规范 `errorCode`；
- `sensitivityClass` 与已应用的 redaction policy。

作为 RFC 0004 extension，Host 可以加入带版本的 observer metadata，标识产生观测的 Runtime 或 Adapter component。它不属于 v0.1 最小字段，必须由 Host 生成，也不能把 Transport 细节暴露给插件代码。

Host 可以推导包含创建时间、最近 transition 时间、当前 owner 和当前 state 的物化视图。这个视图只是 transition record 上的 cache，不是第二份事实来源；它不能抹掉清理失败、历史 owner 或 sequence gap。在 runtime 之前就被抑制或拒绝的 composition candidate 留在 Composition Plan decision log 中，绝不能变成 observed effect。

首批 effect kind 包括 command handler、service provider、contribution、subscription、route/RPC handler、timer、background job、child process、storage namespace、temporary file 和实验性 legacy effect。

Ledger 是 Host 观测的证据。插件不能写入或重写 ownership record。Adapter 只能通过 Broker SPI 提交观测，由 Broker 附加当前 owner 并校验 resource kind。

## 9. 激活、替换与清理

Activation record 关联协商、授权、provider 选择、effect、诊断和最终状态。

正常 deactivation 时，Broker：

1. 停止接收新的 invocation；
2. 在明确时间边界内 abort 并 drain 自己拥有的工作；
3. 按 contract 规定的顺序释放 effect；
4. 记录每项成功、timeout 和残留 effect；
5. 只有 ledger 到达终态后才把 activation 标记为 disposed。

Process crash 可能让最终记录无法写入。下次启动时，恢复扫描器对比持久 resource marker 与最后的 durable ledger，报告 `orphaned` 或 `unknown`，不能伪造清理成功。

Provider 替换和 HMR 会创建新的 activation identity。历史 ownership 继续可查询，当前 resource 根据 composition contract 指向新 owner。

## 10. 诊断图

面向用户的诊断应该回答“哪里失败、我可以做什么”，同时避免暴露内部实现。开发者诊断可以沿稳定 ID 追踪：

```text
artifact → manifest → negotiation/grant → activation
         → provider/contribution → invocation → effect → error/cleanup
```

图中记录 causal ID，而不是任意 object reference 或 stack-trace object。原始上游 cause 留在 Host 自有日志中，通过 ID 关联。

建议的稳定结果包括：

- API 不兼容或缺失 capability；
- permission denied；
- provider 未解析或冲突；
- contribution ID 重复；
- activation 失败或 timeout；
- invocation 失败或 cancelled；
- cleanup 不完整；
- validation evidence 过期；
- 检测到 legacy effect；
- report subject 不匹配。

## 11. Legacy effect 与迁移

迁移工具可以生成只读 `legacyEffects` 检查段，描述已知 source patch、mixin target、私有 service 访问或未受管全局副作用。

它只是诊断元数据：

- 不授予权限；
- 不让 effect 变成可移植；
- 不把 private seam 升级成 Fabric capability；
- 不允许普通插件在 manifest 中提供可执行 patch 指令。

实验性、固定版本的 DSH Adapter 可以使用经过审查的兼容桥。这类 effect 必须标记 experimental，在被公开、可测试 capability 替代之前不能通过 portable conformance。

## 12. 隐私与保留

- 标准报告绝不保存消息正文、prompt、模型输出、secret value、authorization code、原始环境变量或未脱敏本地路径。
- 使用不透明 scope/resource ID 和明确 sensitivity label。
- Ephemeral presentation 数据不进入 durable ledger；如审计需要，只记录“已经展示”等脱敏事实。
- 在安全/审计策略允许范围内，用户可以检查并删除本地诊断。
- Telemetry export 是独立、opt-in policy；存在本地 ledger 不代表允许上传。
- 限制报告大小、历史长度和保留期；摘要不能丢掉失败清理和未解决冲突。

## 13. 一致性要求

兼容原型至少测试：

- artifact digest 不匹配会让旧证据失效；
- unknown check 绝不能变成 pass；
- validation reason code 稳定，本地化文本与 code 分开；
- 每个 Fabric 管理的 registration 都获得当前 plugin/activation owner；
- 插件不能冒充其他 owner；
- 替换记录新旧 owner，并遵循 composition policy；
- 同步和异步资源在 deactivation 时释放；
- timeout/crash 路径报告 incomplete 或 unknown cleanup；
- 序列化报告不包含敏感值；
- 目录收录本身不能生成 validation label；
- 声明 legacy effect 绝不能授权执行；
- 来自不同 Host descriptor、platform、suite 或 artifact 的报告明确显示不匹配。

测试必须能在 headless 环境运行。至少一个真实 Adapter integration test 应把 ledger 观测与实际 DSH registration/teardown 对比。

## 14. 与其他工作的关系

- [RFC 0001](0001-plugin-manifest-capabilities-events.zh.md) 管理 manifest、协商、生命周期和基础 activation ownership。
- [RFC 0003](0003-service-providers-and-composition.zh.md)管理 service-provider 冲突与替换策略；本 RFC 只把最终 runtime transition 记录为 observed effect，decision 仍留在 Composition Plan。
- [RFC 0002](0002-runtime-presentation-invocation-transport.zh.md)管理 invocation 与 Runtime/Presentation identity；本 RFC 记录不透明 identity 和脱敏结果。
- [DSH 插件需求调研](../research/dsh-plugin-needs.zh.md)包含 private route、UI 注册、process、package operation 和 monkey patch 等需要 ownership 的真实例子。
- [DSH Community Market](../../../dsh-community-market/README.zh.md)可以展示报告，但不能自行创建或提升其 trust class。

## 15. 开放问题

1. 除 RFC 0001 最小记录外，哪些 transition record 与物化视图必须持久化，哪些可以只保留在内存？
2. validation check ID 与 reason code 的 namespace 由谁管理？
3. 哪类报告需要签名、透明日志或撤销？
4. 如何跨包管理器一致表示 package script 和 native module？
5. 什么最小 recovery marker 可以在不保存用户路径的情况下发现 orphan？
6. 哪些诊断分别对普通用户、插件作者、Host 维护者和安全审核者可见？
