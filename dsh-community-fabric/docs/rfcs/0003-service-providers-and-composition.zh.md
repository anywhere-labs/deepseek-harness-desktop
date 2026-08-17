# RFC 0003：服务 Provider 与确定性组合

[English](0003-service-providers-and-composition.md) | 中文

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft / 征求意见 |
| 目标 | v0.1 之后的 service runtime；v0.1 只预留语义位置 |
| 范围 | 服务依赖、Provider 与插件集合的确定性组合 |
| 依赖 | [RFC 0001](0001-plugin-manifest-capabilities-events.zh.md) |
| 社区输入 | [Issue #23 的 composition 评论](https://github.com/omdsh-dev/community/issues/23#issuecomment-5307228009) |
| 参考实现 | DSH Community Fabric（尚未实现） |

## 0. 一句话摘要

Fabric 需要在执行任何插件代码之前完成插件集合的组合。一个插件可能需要 Host capability 或服务、提供某个服务实现、贡献可发现的产品元数据、申请权限并订阅事件。这是五类不同声明，绝不能被压进同一个泛化的 `capabilities` 容器。

本 RFC 提出静态计算的**组合计划（Composition Plan）**。Planner 读取 manifest、Host Descriptor、contract registry、授权、策略与已保存的用户选择，把插件集合判定为 `merge`、`soft-conflict`、`selection-needed` 或 `hard-conflict`。Provider cardinality 和仲裁规则属于每项版本化 service 或 contribution contract。插件发现顺序、包管理器顺序与 activation 时机永远不能作为仲裁输入。

未来的 Broker 只能依据这份计划创建 activation instance、把 consumer 绑定到 Provider、替换 Provider 并释放依赖资源。这样，插件组合能在启动前被解释，也能在 HMR、profile 重组、健康状态变化或退出时恢复到可控状态。

## 1. Draft 边界

这是一份设计草案，不是插件作者今天可以使用的 API。它扩展 [RFC 0001](0001-plugin-manifest-capabilities-events.zh.md) 的模型；后者的实验性 v0.1 runtime 仍只包含 Host 提供的 capability、生命周期、`storage.local`、`commands` 和一个不可变观察事件。

在 v0.1 中，`requires`、`provides`、`contributes`、`permissions` 和 `subscriptions` 只在标准设计中保留不同含义，不代表五类字段都能执行。在本 contract 与带版本 schema revision 被接受前，RFC 0001 的 v0.1 schema 会拒绝 `provides` 和 `requires.services`。v0.1 **不会**发布通用的插件服务注册表、动态依赖图、Provider 健康协议或热替换 runtime。Host 不得宣称这些功能属于 Fabric v0.1 一致性范围。

本 RFC 同样不会：

- 向插件暴露通用 service locator、原始 Cordis/Koishi Context、DSH 对象或依赖注入容器；
- 把 trusted in-process 执行中的 capability 声明包装成安全沙箱；
- 引入按需激活——v0.1 仍在组装 runtime generation 时激活所有已选中、已授权的插件；
- 把 model、search、Git、UI、tool 或 storage 等所有服务塞进一套万能协议；
- 允许通过运行时注册修复静态无效的插件集合；
- 要求零停机 Provider 替换或自动 fallback。

“必须”“应该”“可以”沿用 RFC 0001 中的草案强度。只有 schema、参考 Broker 和一致性 fixtures 被接受后，它们才会构成兼容承诺。

## 2. 术语与两类依赖

### 2.1 Host capability

**Host capability** 由 Host integration 或其版本化 DSH Adapter 实现和拥有。Host 在 Host Descriptor 中公布它。插件可以依赖它，并在适用时申请使用权限，但不能通过 `provides` 替换或遮蔽它。

例如 activation-scoped logging、`storage.local`、受控网络访问，或注册某类领域 Provider 的 API。Capability 可以暴露 Provider SPI，但 capability 本身仍由 Host 拥有。

### 2.2 插件提供的服务

**插件提供的服务**是一项版本化领域 contract，由一个插件 activation 实现，另一个插件通过 Broker 生成的强类型 proxy 使用。例如未来可能出现 `git.client`、`models.provider` 或 `search.provider`。

全局 service contract 需要定义请求与结果 schema、cardinality、允许的 scope、版本和 feature 协商、选择、健康、取消、超时、错误、teardown 与一致性测试。Package 名或插件 ID 不是 service contract。

Requirement namespace 必须表明自己解析的是哪一层。`requires.capabilities.storage.local` 向 Host 请求；`requires.services.git.client` 请求 Composition Planner 寻找兼容 Provider。同一个无类型限定的字符串不能同时用于两层，否则 manifest 无效。

### 2.3 Provider 与 Provider instance

**Provider 声明**表示插件可以实现某项 service contract。**Provider instance** 是某个 activation instance 在一个允许 scope 内拥有的运行时 binding。Provider 所在 package 的版本、实现版本与 service-contract version 是三个不同的值。

只有 service contract 明确允许 Host Provider 时，Host 才能实现某项领域服务。Provider eligibility 为 `host-only` 的 contract 完全不接受插件 Provider。

### 2.4 Runtime generation 与 Composition Plan

一个 **runtime generation** 由一组已选插件及其 Host Descriptor、授权、策略、选择与解析后的版本构成。**Composition Plan** 是在执行插件代码之前为该 generation 计算出的规范化、机器可读结果。

计划包含依赖边、候选项、已选 Provider、协商后的版本/feature、contribution ownership、被抑制的候选项、待授权状态，以及每个决定的 provenance。相同的规范化输入必须在每个兼容 Host 上产生相同计划。

## 3. 五类声明

Manifest 必须在结构和语义上分开以下声明：

| 声明 | 回答的问题 | 权威与效果 |
| --- | --- | --- |
| `requires` | 哪些对象必须或可以已存在？ | 对命名 Host capability 或 service contract 的兼容依赖。缺少 required 项会阻止依赖者 activation；缺少 optional 项时进入已声明的降级路径。 |
| `provides` | 这个插件能实现哪项 service contract？ | 只表示 Provider 候选资格。它不会授予权限、选择 Provider 或激活代码。 |
| `contributes` | 这个插件向产品提供什么可发现对象？ | Command、panel 请求、renderer ID 或 setting 等静态元数据。Host 负责验证、位置、组合与呈现。 |
| `permissions` | 插件请求用户或策略授予哪项敏感操作或数据 scope？ | 只表示授权请求。它既不证明 Host 支持，也不满足依赖。 |
| `subscriptions` | 插件激活后应收到哪些版本化事件流？ | 只表示投递意向。它不是 capability、permission、dependency、contribution 或 activation trigger。 |

同一项功能可能需要多类声明。一个 search 实现可以 `provide` search service、`require` Host 的受控网络 capability、申请某个网络来源 `permission`、`contribute` 设置元数据，并 `subscribe` 凭据撤销事件。这些声明互不隐含。

下面是未来可能采用的形状，仅用于说明，不是冻结后的 manifest schema：

```json
{
  "requires": {
    "capabilities": {
      "storage.local": { "version": ">=0.1.0 <0.2.0", "optional": false }
    },
    "services": {
      "git.client": {
        "version": ">=1.2.0 <2.0.0",
        "requiredFeatures": ["status"],
        "optionalFeatures": ["worktrees"],
        "optional": false,
        "as": "gitClient"
      }
    }
  },
  "provides": [
    {
      "service": "git.client",
      "providerId": "com.example.git-native/client",
      "contractVersion": "1.4.0",
      "features": ["status", "worktrees"],
      "scope": "profile"
    }
  ],
  "contributes": {
    "commands": [
      { "id": "com.example.git-native.refresh", "title": "Refresh Git Status" }
    ]
  },
  "permissions": {
    "required": [
      { "name": "fs.read", "scope": "workspace" }
    ]
  },
  "subscriptions": [
    { "event": "workspace.changed", "version": ">=1.0.0 <2.0.0" }
  ]
}
```

Tooling 必须拒绝未声明的运行时 binding、报告声明后从未绑定的项目，并且不能把 permission/grant 状态写成兼容性声明。

## 4. Contract 身份、版本与 feature

### 4.1 全局治理的 contract ID

可移植 Host capability、service contract、event type 与标准 contribution kind 使用 Fabric registry 中全局治理的 ID，例如 `storage.local` 或 `git.client`。任何私有实现都不能重新定义这些 ID 的含义。组织私有 contract 使用经过所有权证明的 namespace，例如 `x-org.example.git.client`。

### 4.2 Publisher namespace 下的资源 ID

Provider ID、contribution ID、command、renderer 与其他插件资源使用 publisher 控制、全局唯一的 namespace，通常采用反向域名前缀。ID 是稳定身份，不是展示名称。Package 更新不能偷偷更换已有 ID 的 owner。

两个已安装声明声称拥有同一全局资源 ID 时属于 hard conflict；只有资源 contract 明确定义更新/替换身份，且 package transaction 能证明身份连续性时除外。后加载的声明永远不能覆盖先加载的声明。

### 4.3 版本协商

Planner 分开保存以下值：

| 值 | 含义 |
| --- | --- |
| Plugin version | 包含 Provider 或 consumer 的 package 发布版本。 |
| Service-contract version | 请求/结果与生命周期 contract 的 SemVer 版本。 |
| Required range | Consumer 可以使用的 contract version。 |
| Provider-supported range/version | 实现已经通过测试的 contract version。 |
| Feature set | 兼容 contract line 内命名的 optional 或 required 扩展。 |

只有 consumer、Provider、Broker 与 Host/Adapter 支持范围的 contract-version 交集非空时，候选项才兼容。Registry 定义确定性选择规则；默认选择双方共同支持的最高稳定版本。只有所有相关 range 都明确允许时，prerelease 才参与协商。

只能在选出 contract version 后协商 feature。缺少或不认识 required feature 会让候选项不兼容；缺少或不认识 optional feature 会被记录为不可用，生成的 API 不包含它。Feature 不能用来在版本未变化时偷渡 breaking contract change。

计划记录已选版本、支持的 feature、排除的候选项和可读原因。Consumer 不能检查 Provider package 后根据其 package version 猜测支持情况。

## 5. Cardinality 与 Provider eligibility

每项 service 与 contribution contract 必须把 cardinality 和“谁有资格提供”分开声明。把二者合成一个 mode 会导致一些合法 contract 无法表达，例如 Host-only 但允许多个 scope instance 的 service，或候选项可以同时来自 Host 和插件的 selected service。

### 5.1 Cardinality

| Cardinality | 含义 | 存在多个声明时的静态结果 |
| --- | --- | --- |
| `many` | 可以有零个或多个 Provider/resource 共存。Contract 定义枚举、合并、selector、pipeline 或逐 invocation 路由语义。 | ID 与 contract rule 兼容时为 `merge`，否则进入相应 conflict class。 |
| `single` | 一个 scope 内最多存在一个 Provider/resource；这不表示它一定 required。 | 多于一个兼容 claim 时为 `hard-conflict`，除非 contract 定义了显式替换 transaction。 |
| `selected-one` | 可以安装多个候选项，但该服务在某 scope 内被 required 时只能选择一个。 | 有效的已保存选择或策略可完成解析，否则为 `selection-needed`。 |

Cardinality 具有 scope。Contract 必须说明 instance space 属于 runtime、profile、workspace、session、invocation 或另一种已注册 scope。Provider 不能扩大声明的 scope，Host 也不能把全局选择偷偷当成 workspace 选择。

对于 `many`，service contract 仍必须定义“多个”的含义。返回全部 Provider、合并值、按明确 selector 选择、执行 pipeline 和询问用户是不同协议。泛化的“最高 priority 获胜”不是充分规则。

### 5.2 Provider eligibility

| Eligibility | 含义 | 无效 claim |
| --- | --- | --- |
| `plugin-only` | 只有已声明的插件 Provider 可以满足该 service。 | Host implementation 不能静默遮蔽或满足它。 |
| `host-only` | 只有 Host Descriptor 中公布的 Host/Adapter implementation 可以满足它。 | 任何插件 `provides` claim 都是 `hard-conflict`。 |
| `host-or-plugin` | Host 与插件实现共同作为候选项，遵循相同版本、feature、scope、cardinality、选择和 provenance 规则。 | Host candidate 不能仅因为内置就获得隐式优先级。 |

Provider eligibility 不会选择实现，也不授予 permission。对于 `host-or-plugin`，contract 仍必须提供明确的选择或合并规则；Host identity 只是 provenance，不是仲裁优先级。不表示可调用 Provider 的 contribution contract 则为自己的 resource kind 声明等价 ownership policy。

## 6. 静态组合结果

Planner 在 activation 前评估完整的已选插件集合，并为每项 service、contribution 与依赖 activation 分配 disposition：

| 结果 | 含义 | Host 必须采取的行为 |
| --- | --- | --- |
| `merge` | 所有声明都能按照 contract 的确定性 many/merge rule 组合。 | 纳入每个已接受 owner，并记录规范化顺序或路由。 |
| `soft-conflict` | 声明发生重叠，但已发布的确定性策略能够抑制、调整位置、路由或以其他方式解决，无需临时发明语义。 | 应用具名策略、保留完整 provenance，并在诊断中显示被抑制/调整的结果。 |
| `selection-needed` | 某项由用户或策略选择的 contract 存在多个有效候选项，但当前没有有效选择。 | 不能猜测。只阻止受影响的 required dependent，并通过 UI 或 headless 配置请求明确选择。 |
| `hard-conflict` | 插件集合违反身份、ownership、版本、feature、scope、cycle 或 cardinality 规则，并且不存在已发布的解决方案。 | 按 Host 策略拒绝受影响的 generation 或插件子集；绝不能静默地部分激活。 |

缺少 required dependency 与 required grant 被拒也是阻塞诊断，但它们和 collision 不同：应该分别报告 `dependency-unsatisfied` 和 `authorization-required`，不能误报成 conflict。

Composition Plan 必须可序列化，并且至少能够解释：

- 每项 claim 来自哪份 manifest 和 Host Descriptor；
- 每条规则来自哪个 contract 与 registry version；
- 应用了哪项用户选择或管理策略；
- 每个候选项为什么被接受、抑制、等待选择或拒绝；
- 哪些 activation 因此被阻止或降级；
- contract 确实规定 ordered merge 时使用什么规范化顺序。

Service dependency graph 必须无环。Late-bound cycle 需要单独 contract，不属于本 RFC；没有这种 contract 时，cycle 是 hard conflict，诊断必须包含完整循环路径。

### 6.1 加载顺序不是策略

文件系统枚举、npm dependency 顺序、manifest 发现顺序、对象插入顺序、网络到达顺序与 activation 完成顺序都不能选择赢家或改变计划。

Contract 可以定义显式 priority、selector 或用于合并的稳定字典序。相同 priority 仍需要声明 tie rule。字典序适合可复现展示或拼接，但不能偷偷选择语义上排他的 Provider，除非 contract 明确把这种行为规定为公共语义。

一致性测试必须排列相同输入的所有顺序，并得到逐字节相等的规范化计划。

## 7. 用户与策略选择

对于 `selected-one`，Host 拥有 selection state。Selection key 包含 service contract、允许的 scope 与稳定 Provider ID；插件不能直接写入选择。

Selection UI 或 headless 配置必须展示每个候选项所属插件、plugin/contract version、协商后的 feature、申请的 grant、当前 health evidence、兼容/测试证据和排除原因。出现在市场中或曾被选择不代表推荐。

选择优先级必须明确且可审计，例如：

1. 适用的管理策略；
2. 适用且仍有效的用户选择；
3. 只有 contract 被允许拥有 default 时，才应用 contract-defined default；
4. 否则进入 `selection-needed`。

Host 不能根据安装或加载顺序发明默认项。已选 Provider 消失或不再兼容时，只有事先批准的策略明确允许 fallback，Host 才能使用其他 Provider；否则回到 `selection-needed`，不受影响的插件继续运行。

只有 scope 与 Provider identity 仍然有意义时，selection 才应该可移植。导入 profile 时应保留无法解析的选择，而不是把它静默映射到名称相似的 Provider。

## 8. Runtime binding 与 activation ownership

未来的 Broker 只能绑定 Composition Plan 已授权的 Provider 与依赖。运行时代码不能新增 contract、改变 cardinality 或让不兼容候选项变得有效。

每个 registration、typed proxy、listener、timer、stream、operation 与 child scope 都属于一个 activation instance。即使插件清理抛错，Broker 也会记录 owner 并移除其 registry entry。插件不能 unregister、replace 或 dispose 另一个 activation 的资源。

Provider replacement 与 HMR 必须始终创建新的 activation identity，即使 plugin version 和 Provider ID 都没有变化。旧 activation identity 永远不能复用；它作为历史 provenance 保留，当前 binding 则指向新 owner。

Activation 是 ownership boundary。如果一个 activation 拥有多个不可分离的 Provider 或 contribution，替换其中一项时，计划必须 transition 所有受影响资源与 dependent。需要独立 replacement 的 Provider 必须进入自己已声明的 child activation scope，不能事后脱离 owner。

Consumer 只能通过生成的窄类型 handle 获得自己声明过的 dependency。Fabric 不暴露 `ctx.get(string)`、registry 枚举或原始 Provider object。Generation 或 Provider 被 dispose 后，handle 立即失效，并返回稳定的 `service-unavailable` 错误。

未来的开发体验可能类似下面这样，但名称和签名尚未冻结：

```ts
export default definePlugin((ctx) => {
  // 由 requires.services[...].as 生成，不允许任意 service lookup。
  const git = ctx.dependencies.gitClient

  // 只能绑定 provides 中已声明的 providerId。
  ctx.providers.bind('com.example.git-native/client', createGitClient(ctx))

  ctx.commands.handle('com.example.git-native.refresh', async ({ signal }) => {
    return git.status({ signal })
  })
})
```

Disposal 必须有界且幂等。正常重组时，consumer 在 required Provider 之前停止；依赖边按反向拓扑顺序 dispose，activation 按拓扑顺序重新启动。Host 中止正在进行的调用、按 contract 规定的 drain window 等待、在 deadline 内等待 `Disposable` / `AsyncDisposable` 清理，然后强制移除 registry state 并记录清理失败。

Consumer 不继承 Provider permission，Provider 也不继承 consumer permission。委托敏感权限需要另行规定、具有 scope 和过期时间的 delegation token，以及 audit record。`provides` 本身不授予任何权限。

## 9. Health、替换与 dependent reactivation

每项 service contract 需要说明 health 对 binding 是建议还是硬要求，并定义小型状态模型，例如 `starting`、`healthy`、`degraded`、`unhealthy`、`stopping` 和 `disposed`。Health 是运行证据，不是安全、兼容或正确性的证明。

Provider 只能通过 Broker contract 发布 health。任意插件事件不能改变 selection state。Broker 对 transition 限速，记录原因和时间戳，并阻止已经 dispose 的旧 activation 继续上报。

Required 或 selected Provider 被移除、替换或变为无法绑定时，Broker 执行 generation transition：

1. 在不执行新插件代码的情况下验证并计算替代 Composition Plan；
2. 按 service contract 取消或 drain 调用；
3. 以反向依赖顺序 deactivate 受影响的 dependent；
4. dispose 旧 Provider activation 及其所有 owner-scoped resource；
5. activate 并 health-check 已选 replacement；
6. 按依赖顺序使用新 typed handle 重新 activate dependent；
7. 发布新 generation，或者报告带 provenance 的 transition failure。

在可行情况下，optional dependency 应隔离在 child activation scope，这样丢失 optional Provider 时只需 dispose 并重建使用它的功能。Required dependency 丢失会阻止 dependent activation。

只有旧 Provider 与其状态仍有效，且 contract 定义了安全 rollback boundary 时，才允许 rollback。否则 Host 暴露 degraded 或 selection-needed 状态。它不能保留 stale object reference，也不能偷偷调用另一 Provider。

零停机 handoff 取决于具体 contract，本 RFC 暂缓。Baseline 可以在 replacement 期间暂停调用。

## 10. 调用、取消、超时与错误

每项 service method contract 都要定义请求/结果 schema、副作用、并发、幂等性、取消点、deadline 行为、最大 payload、隐私与 audit 要求。

- 每个异步调用都从 Broker 收到 cancellation signal 和有效 deadline。
- Cancellation 是协作式的；发出取消请求并不能证明远端或原生副作用已经停止。
- Timeout 会结束 consumer 的等待并标记调用结果，但不表示 rollback 已完成。
- 除非 method contract 明确声明安全并定义 idempotency key 或等价语义，否则禁止 retry。
- 在 execution mode 能力范围内，Provider failure 在 Broker 边界隔离。Trusted in-process 执行仍无法容纳 `process.exit`、无限循环或 native crash。
- 除非 service contract 和当前用户/策略选择都明确规定，否则禁止自动“尝试下一个 Provider”。

规范化错误至少区分：

| Code | 含义 |
| --- | --- |
| `service-unavailable` | 当前不存在已绑定且可用的 Provider。 |
| `incompatible-version` | 不存在双方支持的 service-contract version。 |
| `required-feature-missing` | 候选项缺少 required negotiated feature。 |
| `selection-required` | `selected-one` contract 没有有效选择。 |
| `composition-conflict` | 静态 hard conflict 阻止 operation 或 activation。 |
| `provider-unhealthy` | Health policy 阻止使用已选 Provider。 |
| `cancelled` | Caller 或 generation transition 请求了取消。 |
| `deadline-exceeded` | 有效 deadline 已到期。 |
| `provider-failed` | Provider 返回或抛出了规范化 failure。 |
| `activation-disposed` | 发起或服务该调用的 activation 不再拥有有效 handle。 |

Error payload 必须可序列化、有大小限制、经过隐私裁剪，并携带 correlation ID 及 Provider/consumer provenance。原始 stack trace、credential 和任意 thrown object 不能跨越插件边界。每项 contract 需要说明错误会终止单次调用、降级功能、阻止 activation，还是触发 generation transition。

## 11. Composition Plan 与运行时诊断

Host 保存静态计划与 runtime transition。诊断界面或机器可读报告应该能回答：

- 谁声明、提供、选择、绑定、替换和 dispose 了某项资源；
- 发生了哪种版本与 feature 协商；
- 哪项策略或用户操作选择了 Provider；
- 哪些 dependent 被 deactivate 或降级，以及原因；
- 哪些资源清理失败；
- 某个结果属于声明兼容、运行时健康、一致性证据还是未验证 claim。

Composition decision 由 Composition Plan 与 Host/Broker policy 决定。已接受、抑制、选择和拒绝的候选项作为 `decided` 证据留在 Composition Plan 或其 decision log 中。只有真正创建的 binding 或 runtime transition，例如 bind、replace、release 或 cleanup failure，才会以 `observed` 证据进入 Host 观测的 effect ledger。Ledger 绝不能成为仲裁输入。插件日志、事件或返回 payload 不能创建、重写或证明任一类 record；它们最多只能作为明确标记的插件 claim。

这回应了 [Issue #23 讨论](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305656025)中的溯源与影响分析需求，同时不会把市场收录当成验证。

## 12. 一致性与测试矩阵

本 RFC 的 service runtime 从 Draft 毕业前，headless testkit 至少覆盖：

| 领域 | 必需 fixture 与性质 |
| --- | --- |
| 声明分离 | `requires`、`provides`、`contributes`、`permissions` 与 `subscriptions` 不能互相满足或隐含；报告未声明 binding 与声明后未 binding。 |
| 身份 | 全局 contract registry 查询、namespace ownership、重复 Provider/contribution ID、更新连续性与 provider-eligibility 拒绝。 |
| 静态规划 | 每种 cardinality、每种 provider-eligibility 值与四种 composition outcome；缺失依赖和待授权保持不同；dependency cycle 展示完整路径。 |
| 确定性 | 等价 manifest/descriptor 输入的每种排列都产生逐字节相同的规范化计划；文件系统和 activation 时机不会改变结果。 |
| 版本/feature | 空与非空 SemVer 交集、prerelease、required/optional feature、未知 feature 与 Broker/Adapter 支持范围。 |
| 选择 | GUI 等价选择和 headless 选择、scope 优先级、缺失/过期选择、显式 fallback policy 与 profile import。 |
| 生命周期 ownership | 重复 activation、反向顺序 disposal、异步清理 deadline、清理抛错、stale handle 与无资源泄漏。 |
| Health/replacement | Healthy/degraded/unhealthy transition、stale health event、Provider 移除、替换失败、optional child reactivation、required dependent reactivation 与 rollback boundary。 |
| 调用 | 成功、规范化 failure、取消、超时、迟到结果、禁止 retry、并发限制与裁剪。 |
| 互操作 | 同一 planner fixture 在 fake Host 和至少两个独立 Host integration 中通过；runtime fixture 为同一 service contract 使用至少两个 Provider。 |

规范化 plan format、error format、health event 与 transition log 都需要 schema。测试记录标准版本、contract-registry version、Host/Adapter version、plugin version、平台与 testkit commit。通过测试矩阵不等于安全认证。

## 13. 交付阶段

本 RFC 刻意分开语义预留与实现：

### Stage A——v0.1 语义预留

- 在设计中保持五类声明相互独立，同时让 v0.1 schema 拒绝不支持的 `provides` 与 service requirement；
- 预留 Host capability 与 plugin service 两类 namespace；
- 要求 service 与 contribution contract 写明 cardinality、provider/owner eligibility 与 conflict 行为；
- 继续按 generation eager activation 已选 v0.1 插件集合；
- 不暴露通用 plugin service runtime。

### Stage B——静态 planner 原型

- 发布 service/contribution contract registry 与 schema；
- 定义规范化 Composition Plan 和诊断 schema；
- 实现纯函数、headless planner 与排列测试；
- 为 ID、版本、feature、cardinality、scope、conflict、selection 和 cycle 添加 fixture。

### Stage C——Broker runtime 实验

- 实现 activation-owned Provider binding 与 typed consumer proxy；
- 实现有界调用、health、teardown、replacement 与 dependent reactivation；
- 把 runtime 保持在 experimental API range；
- 先使用 fake Provider 验证，再适配真实 DSH service。

### Stage D——领域 contract 与互操作证据

- 通过单独 RFC 标准化高价值具体服务；
- 测试同一 service contract 的至少两个实现；
- 发布跨 Host 证据与运行诊断；
- 只让语义和失败行为已经得到证明的 contract 毕业。

## 14. 开发体验要求

最终工作流应该是：

```text
声明 dependency/provider/contribution/permission/subscription
  → 验证 manifest 与 namespace
  → 预览静态 Composition Plan
  → 使用生成的强类型 contract 实现
  → 运行 fake-Host lifecycle 与 conflict fixture
  → 测试 Provider replacement 与清理
  → 打包，且不导入 DSH、Cordis 或 Host internal
```

SDK 应该从 manifest 和 contract registry 生成窄类型 dependency property 与 binding function。Editor 应该能补全版本和 feature、解释候选项为什么不兼容，并展示与 Host 相同的 Composition Plan。作者不应再协调加载顺序、探测 `ctx.get()`、修改其他插件的 registry entry，或为了消费服务而导入某个具体 Provider plugin。

## 15. 安全与信任

静态规划改善可预测性与知情授权，但不会让任意代码自动安全。在 trusted in-process 模式中，恶意插件仍可能通过 Node.js 或 native module 绕过受支持 API。强制执行仍依赖 RFC 0001 描述的隔离执行规范。

Broker 仍必须强制执行自己的受支持边界：owner-scoped handle、已声明 dependency、schema validation、size/rate/deadline limit、redaction、grant、delegation 与 audit。Provider 的 health、流行度、用户选择或一致性结果不得被展示为安全审核或推荐。

## 16. 开放问题

1. 哪个组织负责治理全局 service-contract ID 与 publisher namespace 争议？
2. 第一版 planner schema 应包含哪些 scope：runtime、profile、workspace、session 和 invocation？
3. Provider 应公布一个精确 contract version，还是经过测试的离散版本集合，而不是宽泛 range？
4. 哪些 selected-one service 可以定义 default，允许 fallback 前需要什么证据？
5. Persistent Provider state 如何在不同实现替换时迁移？
6. 哪些 health signal 足够通用，可以进入 Broker；哪些必须保留为领域特有？
7. 是否存在可移植的 late-bound dependency cycle，还是应该永久禁止 cycle？
8. 哪项最小 service contract 适合作为第一个双 Provider 互操作 fixture？

## 17. 参考与设计输入

- [Issue #23：统一插件 API 与事件提案](https://github.com/omdsh-dev/community/issues/23)，尤其是 [Composition Rules 评论](https://github.com/omdsh-dev/community/issues/23#issuecomment-5307228009)。
- [RFC 0001：Manifest、Capability 与事件模型](0001-plugin-manifest-capabilities-events.zh.md)。
- [调研：成熟插件框架模式](../research/mature-plugin-frameworks.zh.md)，特别是 Koishi 风格的依赖替换与 activation ownership。
- [调研：VS Code 扩展模型](../research/vscode-extension-model.zh.md)，特别是领域 Provider、contribution cardinality、选择、超时与 replacement rule。
- [调研：DSH 插件开发者的真实需求](../research/dsh-plugin-needs.zh.md)，特别是版本化 service negotiation、Provider arbitration、health 与 owner-scoped disposal。

社区评论指出了缺失的组合层，调研文档提供了实现证据。本 RFC 把二者转化为可测试设计，同时让实验性 v0.1 runtime 保持克制。
