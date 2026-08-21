# Agent Note：Desktop profile 与 package-manager service

[English](2026-08-15-desktop-profile-and-pnpm-services.md) | 中文

## 问题

Electron launcher 知道哪个 DSH profile 生成了当前 Cordis generation，但普通 Host 插件无法通过内部命令行参数、`ctx.baseUrl`、settings 或 Loader entry 可靠恢复这项身份。Launcher 会在提供内部 `ctx.cmdlineArgs` 之前消费 `--profile`；Loader base 是模块解析 metadata，而不是 profile capability；settings 在 profile 选择之后才启动；Loader inventory 也不携带 profile provenance。

Desktop 还会内置 pnpm，但找到 package-manager executable 并不足以正确管理 DSH 插件。上游 `dsh plugin` 命令会初始化缺失的 profile、以调用方目录锚定相对 package spec、在 profile 目录中运行 pnpm，并在成功后根据已安装 package reconcile `dsh.profile.bundles`。直接执行 pnpm 会遗漏这些 DSH 语义。各插件自行编写 child-process 代码，还会产生不一致的 lifecycle、cancellation 与 Windows `.cmd` 行为。

因此 Desktop 需要为 profile 身份和受管 package 操作提供明确、作用于单个 generation 的 Host service，同时第三方插件仍须能在不存在这些 Desktop service 的普通 DSH 中运行。

## 决策

Launcher 会在 Loader entry 挂载前提供不可变 bootstrap fact。两个普通 Cordis service 随后在当前 generation 生命周期内拥有公开的 Desktop 边界：`ctx.desktopProfiles` 与 `ctx.desktopPnpm`。两者都不会暴露给 renderer，也不会修改上游 profile manifest、patch 格式、CLI 或固定版本的源码 checkout。

这些是 Desktop 自有的 service contract。当前上游 DSH 并未提供 typed active-profile 或 profile-package-manager service。Desktop 之外的 consumer 必须把两者视为可选能力，并在 service 不存在时保留普通 DSH 行为。

## `desktopProfiles`

`desktopProfiles.current` 是不可变的 `{ name, dir }` 身份，表示生成当前运行 generation 的 profile。`list()` 只读执行发现，`select(name)` 会串行化选择、先持久化目标再请求有序重启，而且绝不会就地改变当前 generation 的身份。

针对同一目标的并发请求会共享同一个 operation。一旦另一个 profile 已被持久化为 pending，在重启之前其它目标不能覆盖它。Cordis 生命周期结束后，保留的 service reference 会拒绝继续使用。Profile 发现与 last-known-good 恢复仍属于 launcher 职责，详见 [profile 管理决策](2026-08-15-desktop-profile-management.zh.md)。

## `desktopPnpm`

`desktopPnpm` 只接受 launcher 为当前 generation 选择的激活 profile。它通过普通 DSH subprocess service 同时持有最多一个 operation，暴露实时 stdout 与 stderr stream，只有在完整 process tree 退出后才 settle `done`，并同时支持输入 `AbortSignal` 与显式 `cancel()`。Service dispose 会先终止并 join 活跃 operation，再释放自身生命周期。

Provider 会使用已签名 application executable 启动内置 pnpm 与 DSH entry。只属于 child 的 environment 会提供当前 DSH home、私有 Electron-backed Node helper、CI 模式，以及安装 native dependency 所需的 Electron ABI 值。参数以 argv 而不是 shell 文本跨越进程边界，因此 Windows 不依赖 consumer 自己发现或直接启动 `.cmd` shim。

### `run()`、`runPlugin()` 与 `installPlugin()`

`run(args, signal?)` 会以当前 profile 目录为 working directory 直接执行内置 pnpm。它是低层 package-manager operation，不承诺 profile 初始化、调用方相对 source 锚定或 DSH bundle reconcile，不能被当作插件管理 API。

`runPlugin(args, invokingDir, signal?)` 会以 `invokingDir` 作为 CLI working directory，为 `remove`、`update` 或恢复时的 `install --no-frozen-lockfile` 等非安装 mutation 启动内置 `dsh plugin --profile <active>`。它会拒绝 `add`。上游 CLI 仍负责进入 profile 目录运行 pnpm，并在 mutation 成功后 reconcile `dsh.profile.bundles`。

插件管理器使用 `installPlugin(request)` 执行 `add`。这个 deep interface 把精确 package name/version 与 recovery receipt 绑定，spawn 前快照 profile，并在完成前封存或恢复快照。其他 plugin mutation 使用 `runPlugin()`。Consumer 拥有面向用户的 deadline 与 progress model；module 拥有 executable 选择、child environment、单 operation gate、process-tree 终止和不接受 consumer 自行传入 profile 的激活 profile。

## 第三方兼容与 dshmarket

支持 Desktop 的可选 consumer 会在普通必需 Host service 可用后，动态解析 `desktopProfiles` 与 `desktopPnpm`。当两者都存在时，不可变 service 身份优先于 config 或 argv 猜测；安装使用 `installPlugin()`，其他 plugin mutation 使用 `runPlugin()`。当两者都不存在时，consumer 保留原有 config/argv 与 DSH CLI 路径，使同一个 package 继续在普通 Web profile 中工作。跨环境插件不能把 Desktop service 声明为必需 Cordis injection。

`dshmarket@1.2.3` 尚未实现该 adapter。它会按 `config.profile`、launcher argv、`web` 的顺序解析目标，然后绑定启动 `dsh plugin` 的私有 child-process 代码；其 package exports 没有 runner 或 route injection seam。Desktop patch 可以提供 profile 名称，PATH shim 也可以让旧命令变得可发现，但两者都不能让该版本消费正式 service。真正集成需要后续 dshmarket release 或持续维护的源码 patch；Desktop 不会 fork 它的 routes。

`1.2.3` 不是 Desktop dependency，也没有预装。它的 npm manifest 与 README 标识为 MIT，但源码仓库和已发布 tarball 都没有完整许可文本与版权通知。MIT notice 必须随再分发副本保留，因此 Desktop 将该缺失视为内置再分发 blocker。用户通过普通 DSH 主动安装与 Desktop 把 package 嵌入 application archive 或 installer 是两个独立边界。采纳时需要重新审计的新版本同时加入可选 service adapter，并随包发布完整 notice。

## 验证

Focused contract 覆盖不可变 profile 身份、只读发现、先持久化再重启的串行选择、已 dispose reference、直接 pnpm 的 argv 与 working directory、`dsh plugin` 的 argv 与调用目录、child-only environment 值、流式输出、cancellation、完整 process-tree settlement，以及 generation 级 busy gate。Windows 验证会断言通过已打包 entry 进行无 shell 的 argv 执行。

Loader smoke 必须证明两个公开 service 能在 Desktop 组合中完成装配，并满足 consumer 声明的 injection。Packaged-runtime gate 必须证明 DSH 与 pnpm entry 是物理 runtime 文件。Focused service test 会验证插件 operation 使用 launcher 的激活选择，而且不向 consumer 暴露自行传入 profile 的参数。在重新审计的新版本同时通过 service-adapter 与许可 gate 之前，production dependency graph 与 packaged archive 必须保持不包含 dshmarket。未来采纳必须固定并记录精确 npm 版本与 integrity，不能依赖可变 tag。

## 考虑过的替代方案

**从 argv、`baseUrl`、settings 或 Loader metadata 推断 profile。** 这些值要么在 plugin tree 之前已被消费、要么出现得太晚，或者只描述模块解析而非 launcher 身份。

**向所有 Host 插件暴露终端的完整 shim 目录。** 这会覆盖用户的 `node` 与 `dsh` 命令，而且仍不能定义 profile ownership、mutation serialization 或 process lifetime。

**使用 `run()` 执行插件 add、remove 与 update。** 原始 pnpm 可以修改 dependency，但会遗漏上游用于控制哪些 dependency 成为 DSH bundle layer 的 reconcile。

**Fork 或静默 patch dshmarket 1.2.3 后嵌入应用。** 这会形成永久的第三方维护与 provenance 责任，同时再分发一个尚未提供必需许可 notice 的 package。

## 结果

Desktop Host 插件现在拥有一个明确的激活 profile 身份来源，以及一条受管的内置 package 操作路径。插件管理器保留上游 DSH 语义，progress 继续由 consumer 拥有，cancellation 会清理完整 process tree，而 Windows 不再要求每个 consumer 自行发明 shell 处理。普通 DSH 仍可通过可选 service detection 保持兼容；dshmarket 预装则继续由明确的 API 与再分发 gate 阻挡。
