# DSH Desktop 插件开发

> **当前接口与 Draft 请勿混淆：** 本文介绍现在可用的 DSH/Cordis 与 Desktop service。`dsh-community-fabric` 中的 manifest、capability 和统一事件模型仍处于[社区 RFC Draft](../dsh-community-fabric/README.zh.md)，尚不能作为依赖或发布目标。

## 先理解两层插件

一个普通 DSH 插件可以提供 Host service、命令、路由、bundle 或 Web Client。它应该尽量只依赖官方 DSH contract，因此可以在命令行、普通 Web profile 和 DSH Desktop 中复用。

Desktop 另外提供两个公开的 Host service：

- `desktopProfiles`：读取当前 profile、发现可选 profile，并请求安全的 profile 切换。
- `desktopPnpm`：在当前 profile 中执行 pnpm，或通过官方 `dsh plugin` 语义管理插件。

它们属于 Electron main 进程中的 Host Cordis generation。Renderer 不能直接读取它们；有浏览器界面的插件仍应使用普通 DSH Web routes、RPC、client metadata、service 和 slot。

完整类型、生命周期和失败语义见 [`dsh-plugin-desktop/docs/plugin-services.md`](../dsh-plugin-desktop/docs/plugin-services.md)。下面只给出选择方式和最小原则。

## Desktop 专用插件

如果插件只应该在 Desktop 中运行，可以把服务声明为 required injection：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type {} from 'dsh-plugin-desktop/profile-service'
import type { DesktopPnpmHandle } from 'dsh-plugin-desktop/pnpm'

export const name = 'example-desktop-plugin'
export const inject = ['desktopProfiles', 'desktopPnpm']

declare function persistPendingReceipt(recovery: {
  readonly packageName: string
  readonly packageVersion: string
  readonly receiptId: string
}): Promise<void>

export function apply(ctx: Context): void {
  ctx.logger.info(`profile: ${ctx.desktopProfiles.current.name}`)
  let active: DesktopPnpmHandle | undefined

  // 将这个函数连接到插件界面的明确用户操作。
  async function installExample(): Promise<void> {
    const recovery = {
      packageName: 'example-plugin',
      packageVersion: '1.0.0',
      receiptId: randomUUID(),
    }
    await persistPendingReceipt(recovery)
    active = await ctx.desktopPnpm.installPlugin({
      invokingDir: process.cwd(),
      recovery,
    })
    await active.done
  }

  ctx.effect(() => {
    return async () => {
      active?.cancel()
      await active?.done.catch(() => {})
    }
  }, 'example plugin operation')
}
```

实际项目应该把 package operation 放在明确的用户动作中，校验目标来源，在安装前持久保存 recovery receipt，在启动时 reconcile 已恢复的 receipt id，读取 stdout/stderr，设置自己的 timeout，并同时检查 `exitCode` 和 `signal`。一个 generation 同时只允许一个 `desktopPnpm` package operation；插件卸载时必须取消并等待它结束。

## 兼容 Desktop 和普通 DSH

如果同一个插件也要在普通 `dsh web` 中运行，不要把 Desktop service 放进顶层 required `inject`。先注入普通依赖，再在 callback 中动态探测：

```ts
export const inject = ['webServer', 'loader']

export function apply(ctx: Context, config: { profile?: string }): void {
  const profiles = ctx.get('desktopProfiles')
  if (profiles === undefined) {
    mountOrdinaryDshManager(ctx, config.profile ?? 'web')
    return
  }

  ctx.inject(['desktopPnpm'], (desktopPnpm) => {
    mountManager(ctx, {
      profile: profiles.current.name,
      profileDir: profiles.current.dir,
      runPlugin: (args, cwd, signal) => desktopPnpm.runPlugin(args, cwd, signal),
    })
  })
}
```

普通 DSH 的 fallback 仍然是插件自己的权威实现。不要从 `process.argv`、`ctx.baseUrl`、settings 或 `$DSH_HOME` 推断 Desktop profile；在 Desktop 中以 `desktopProfiles.current` 为准。

## `run()`、`runPlugin()` 和 `installPlugin()` 的区别

`desktopPnpm.run(args)` 是低层 pnpm operation，cwd 是当前 profile。它不保证 DSH 的 profile 初始化、调用方相对 `file:`/`link:` source 锚定或 `dsh.profile.bundles` reconcile。

`desktopPnpm.runPlugin(args, invokingDir)` 为非安装 mutation 执行打包的 `dsh plugin --profile <active>`，并保留上游插件管理语义。它会拒绝 `add`。`installPlugin(request)` 是可恢复安装路径：它从 receipt metadata 生成精确 package 目标，并拥有 profile 快照/WAL 生命周期。

```ts
await desktopPnpm.installPlugin({
  invokingDir,
  pnpmOptions: ['--save-exact'],
  recovery: { packageName, packageVersion, receiptId },
  signal,
})
desktopPnpm.runPlugin(['remove', packageName], invokingDir, signal)
desktopPnpm.runPlugin(['update'], invokingDir, signal)
desktopPnpm.runPlugin(['install', '--no-frozen-lockfile'], invokingDir, signal)
```

参数始终作为 argv 传递；不要拼接 shell 字符串，也不要依赖 Windows `.cmd` shim。服务会在完整子进程树退出后 settle，并在 generation dispose 时终止仍在运行的 operation。

## 不要依赖的接口

`desktopRuntime`、`desktopPnpmBootstrap`、Electron `BrowserWindow`、托盘注册表、private Node helper、`ELECTRON_RUN_AS_NODE` 和生成的 shim 都是 Desktop 内部实现。即使它们出现在 declaration 或运行时上下文中，也不属于第三方兼容 contract。

## 测试与发布检查

插件至少应覆盖：

- 在普通 DSH 中没有 Desktop service 时仍能加载，或按产品定义保持 pending。
- Desktop 中读取的 profile name/dir 与用户实际选择一致。
- package operation 的取消、非零退出、spawn failure 和 generation teardown。
- 插件变更后重新启动，bundle 能进入下一次 Loader 组合。

开发者可以先阅读 [架构说明](architecture.md)，再使用包级 [service contract](../dsh-plugin-desktop/docs/plugin-services.md)。

## 生态愿景：保持插件生态可组合

DSH 的插件生态正在快速增长。插件越多，它们能否协同工作就越重要——如果每个插件都假设或覆盖其他插件的内部实现，装几个插件就会开始冲突，生态会逐渐碎片化。

我们倡导像浏览器插件一样的开发方式：大家在同一个平台上、按同一套约定扩展，而不是各自维护一份改过的运行时。DSH Desktop 是这套方式的第一个实践者——桌面壳本身就是一个普通插件，与官方、第三方插件走同一条组合路径，没有任何特权。

为此我们发起一项开发规范倡议，希望它通过社区的采纳成为事实标准：

- **组合优先**：通过官方 slot、service 和 patch 组合能力，不要假设或覆盖其他插件的内部实现。
- **声明清晰**：明确声明依赖的 service 和 slot，不依赖运行时巧合。
- **兼容优先**：升级保持向后兼容，不破坏已有组合。

倡议是活文档，随生态实践更新，接受社区讨论和修订。插件市场上线后，遵循共同约定的插件将更容易被发现、安装和判断兼容性，让"按规范开发"成为对每个作者都有利的选择。完整愿景见 [DSH 插件生态倡议书](plugin-ecosystem.md)；未来互操作 contract 的讨论见 [DSH Community Fabric](../dsh-community-fabric/README.zh.md)。
