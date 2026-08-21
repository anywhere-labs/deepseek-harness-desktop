# 安全策略

[English](SECURITY.md)

## 当前状态

`dsh-community-market` 已完成并内置于 DSH Desktop。它以开放方式连接各种插件数据源：任何人都可以提供、接入和使用符合公开 Schema 的来源，已有 API 也可以通过随 Market 发布的受审 adapter 成为合作数据源。Host/Client runtime 会校验并规范化目录数据、持久化用户拥有的来源选择，并且只在来源被明确启用后执行受限 HTTPS 请求。Market 通过受管 package 能力实现有限的精确版本 npm 安装和基于 receipt 的卸载；renderer 不能访问 package manager。

## 信任模型

目录响应是不可信远程输入。被目录收录或显示在**可安装**中，不等于经过安全审核，也不代表兼容性承诺、维护者身份验证或推荐。插件仓库链接和展示信息会先经过校验，并且只能作为不可执行数据渲染。

安装插件的风险高于浏览，因为安装后的插件及其依赖树会成为以用户权限运行的本地第三方代码。当前安装器会拒绝目标 package 中声明的 `preinstall`、`install`、`postinstall` 或 `prepare`；这项策略不会检查或证明全部依赖代码的安全性。Package 操作必须保持以下规则：

- 只有用户明确点击并确认后才开始安装；
- 执行前展示 Host 已复核的精确 npm package/版本和当前 profile；
- 不执行目录响应中的命令字符串、脚本或 HTML；provider 命令会被丢弃，Host 重建的手动命令也必须保持有界、只用于展示，并且绝不会发送给 Desktop action；
- Market 安装只通过 Desktop 受管的可恢复安装能力；普通 package 操作不能对 `plugin add` 使用未保护路径；
- 只有通过独立 registry、仓库、integrity、bundle、deprecated、lifecycle script、DSH rc.2 和内置 Node.js 检查的精确稳定 npm 目标才能继续；
- 预览与读取可取消；确认被接受后，串行 mutation 由 Host 持有，UI 断连只会丢失响应；当前 profile 变化或一次性 preview 无效时必须拒绝；
- 卸载只接管当前 profile 中 package 与 bundle 仍然精确匹配的合法 Market receipt，且不依赖目录来源继续存在；
- 打开 DSH 终端只能使用严格的空 body 操作，不携带命令、路径或 profile，也不会粘贴或执行界面展示的手动提示；
- Market 安装，或通过 Desktop 内置 DSH 终端运行 `dsh plugin add` 之前，Desktop 只会为当前 profile 的 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 创建私有快照；在该终端直接执行 `pnpm`/`npm`，或在外部系统终端运行命令，都不在此边界内；
- 快照不会备份或主动回滚 `node_modules`、环境变量或独立凭据存储；三个白名单文件会按原内容复制，因此不得在其中嵌入凭据；
- 一条恢复记录会阻止下一次受保护的插件添加，直到后续 Desktop generation 成功启动 Host 并收到 Renderer 健康报告，或完成恢复 reconcile；
- 如果 Host 启动失败，或 Renderer 失败、未在 30 秒内报告健康，Desktop 会先保存本地诊断归档，再只恢复已识别的前后配置状态；未知漂移要求手动恢复，自动重启最多发生一次；
- 修改成功后可以签发短时、一次性重启许可；正常成功路径的重启仍是独立、明确的用户选择，绝不会静默发生；
- 不在 Market 界面或面向用户的错误中暴露凭据、环境变量、原始响应 body 或本地路径；
- 目录故障不会阻止 DSH 或 Desktop 启动。

自动恢复诊断归档只保存在本地，Market 不会上传。它可能包含日志、系统信息和 crash 证据，因此必须按敏感数据处理，也不能描述为已经完全脱敏。

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
