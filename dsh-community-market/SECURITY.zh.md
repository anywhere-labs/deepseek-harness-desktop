# 安全策略

[English](SECURITY.md)

## 当前状态

`dsh-community-market` 仍在 monorepo 内保持 private，正在进行 Desktop 集成测试。Host/Client runtime 会校验并规范化目录数据、持久化用户拥有的来源选择，并且只在来源被明确启用后执行受限 HTTPS 请求。在 DSH Desktop 中，它还通过受管 package 能力实现了有限的精确版本 npm 安装和基于 receipt 的卸载；renderer 不能访问 package manager。

## 信任模型

目录响应是不可信远程输入。被目录收录或显示在**可安装**中，不等于经过安全审核，也不代表兼容性承诺、维护者身份验证或推荐。插件仓库链接和展示信息会先经过校验，并且只能作为不可执行数据渲染。

安装插件的风险高于浏览，因为安装后的插件及其依赖树会成为以用户权限运行的本地第三方代码。当前安装器会拒绝目标 package 中声明的 `preinstall`、`install`、`postinstall` 或 `prepare`；这项策略不会检查或证明全部依赖代码的安全性。Package 操作必须保持以下规则：

- 只有用户明确点击并确认后才开始安装；
- 执行前展示 Host 已复核的精确 npm package/版本和当前 profile；
- 不执行目录响应中的命令字符串、脚本或 HTML；provider 命令会被丢弃，Host 重建的手动命令也必须保持有界、只用于展示，并且绝不会发送给 Desktop action；
- Desktop 安装只通过受管的 `desktopPnpm.runPlugin()` 能力；
- 只有通过独立 registry、仓库、integrity、bundle、deprecated、lifecycle script、DSH rc.7 和内置 Node.js 检查的精确稳定 npm 目标才能继续；
- 预览与读取可取消；确认被接受后，串行 mutation 由 Host 持有，UI 断连只会丢失响应；当前 profile 变化或一次性 preview 无效时必须拒绝；
- 卸载只接管当前 profile 中 package 与 bundle 仍然精确匹配的合法 Market receipt，且不依赖目录来源继续存在；
- 打开 DSH 终端只能使用严格的空 body 操作，不携带命令、路径或 profile，也不会粘贴或执行界面展示的手动提示；
- 修改成功后可以签发短时、一次性重启许可；重启仍是独立、明确的用户选择，绝不会静默发生；
- 不把凭据、环境变量、原始响应 body 或本地路径暴露给界面或日志；
- 目录故障不会阻止 DSH 或 Desktop 启动。

任何削弱这些规则的实现，都必须在合并前接受明确的安全审查。

## 用户添加的目录来源

添加来源是一次独立、明确的用户操作；远程 manifest 不能自行启用，也不能决定优先级。生产客户端只接受 HTTPS 目录端点，必须拒绝 URL 凭据、fragment、不安全 scheme，以及指向 loopback、私有网络、link-local 或云 metadata 地址的重定向。每一次重定向和 DNS 解析都要重新校验，避免起初公开的 URL 最终变成内网请求。

来源请求不携带 ambient cookie 或凭据，并且必须限制重定向次数、超时、并发、解码后响应大小、条目数、嵌套深度和字符串长度。响应必须是 JSON，且要先通过公开 Schema 再进入标准化。来源 manifest 不得提供远程适配器代码、脚本、HTML、安装命令、header 或 secret。只有开发模式可以显式开启 loopback 例外，它不得改变生产默认值。

同一时间只选择一个来源进行浏览。该来源故障时可以在其名称旁显示状态，但不得触发兜底来源、修改用户选择、清除本地安装 receipt，或阻止 DSH/Desktop 启动。

## 报告安全问题

如果发现可能的安全问题，请通过 [t4wefan@qq.com](mailto:t4wefan@qq.com) 私下联系我们。请提供受影响的版本或 commit、操作系统、复现步骤、预期影响，以及可以安全分享的最小 proof of concept。

不要发送 secret 或个人数据；未修复漏洞也不要直接提交公开 issue。普通 bug、目录元数据修正和功能建议可以使用仓库的公开 issue tracker。

## 第三方插件与目录问题

目录中第三方插件的漏洞通常应先报告给插件维护者；错误或误导性的目录条目也应报告给目录 provider，无论它是合作提供方还是用户自己添加的来源。只有市场壳本身错误处理该条目或展示了不安全操作时，才需要同时向本项目报告。
