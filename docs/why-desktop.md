# 为什么做 DSH Desktop

## 我们解决什么问题

DeepSeek Harness 的核心是一个可组合的 agent harness。它适合通过命令行和 Web UI 使用，也适合开发者把模型、工具、会话和工作流组合成自己的运行时。但对很多用户来说，第一次运行仍然要面对 Node.js、profile、依赖安装、端口和进程生命周期。

DSH Desktop 的目标不是重新实现 Harness，而是把同一个运行时放进一个容易启动、容易管理、符合操作系统习惯的应用里：

- 安装包负责提供 Electron、Node 运行时和固定版本的 DSH 依赖。
- 应用负责窗口、托盘、单实例、退出和本地服务生命周期。
- 用户仍然使用官方 DSH 的 profile、插件、会话和 Web UI。
- 上游 Harness 继续拥有 agent、模型、工具、会话和 Web 客户端的核心语义。

因此 Desktop 是一个产品入口和运行时适配层，不是上游项目的替代品，也不是把上游源码复制一份再长期分叉。

## 为什么坚持插件化

“一切皆插件”让 Harness 的能力可以被组合，而不是被一个固定应用绑死。Desktop 采用同一原则有三个直接好处：

1. **上游能力保持可替换。** Desktop 可以使用官方 Web client，用户的 profile 也可以加入模型、工具、界面和工作流插件。
2. **桌面能力保持可扩展。** profile 管理和打包环境提供的能力可以通过明确的 Host service 给插件使用，而不是让每个插件猜 Electron 的内部对象。
3. **边界更容易维护。** 上游 DSH 负责 agent 语义，Desktop 负责原生窗口和系统集成，第三方插件只依赖自己真正需要的 contract。

插件化也意味着不是所有东西都应该暴露。第三方插件只能使用明确公开的接口，不能直接控制窗口、托盘、安装器等内部实现；稳定的边界比“什么都能访问”更容易升级和排错。公开接口的细节见[插件开发](plugin-development.md)。

## Desktop 自己提供什么

当前 Desktop 主要提供：

- macOS、Windows 和 Linux 原生窗口、托盘和单实例生命周期。
- 兼容模式和高级模式。兼容模式保留上游默认客户端；高级模式提供 Desktop 自有的布局、窗口材质和原生拖动区域。
- 多 profile 选择。当前 generation 的 profile 身份由 Desktop 明确提供，切换通过有序重启生效。
- 内置终端和固定版本 pnpm 环境。它们只作用于 Desktop 自己创建的进程，不修改用户的全局 PATH。
- 面向插件开发者的一组受控扩展接口（详见[插件开发](plugin-development.md)）。
- 版本检查、用户确认后的安装包下载，以及 macOS DMG/Windows NSIS 的平台交接。

## 我们刻意不做什么

- 不把上游 Web UI 重新实现成 Electron 原生页面。
- 不在兼容模式中覆盖上游 layout、sidebar 或 conversation 组合。
- 不把记录复制到另一个“Desktop 数据库”；官方 profile 默认共享 DSH home 中的会话和设置。
- 不给第三方插件一个未定义的 Electron 私有 API。
- 不把 roadmap（插件市场、手机远程、Channels）写成当前版本已经交付的功能。

## 适合谁

- 只想安装后直接使用 Harness 的用户：从[用户指南](user-guide.md)开始。
- 想安装或开发 DSH 插件的用户：先读[插件开发](plugin-development.md)，再看 [Desktop service contract](../dsh-plugin-desktop/docs/plugin-services.md)。
- 想理解启动、profile 和打包边界的维护者：阅读[架构说明](architecture.md)和包级 [README](../dsh-plugin-desktop/README.md)。
