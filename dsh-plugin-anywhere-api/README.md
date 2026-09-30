# dsh-plugin-anywhere-api

Anywhere 模型网关（Anywhere Model Gateway）在 DSH 里的两个表面：

- **侧边栏底部卡片**（`sidebar.footer.action`）：未登录时显示「Anywhere 模型网关」，
  登录后显示「余额 / 今日用量」两组金额（USD）。两种状态都以官方插件插画领衔——官方 footer
  条目的惯例是图标 + 文字，且正下方的账号行已经承担了用户头像。
  **点击卡片打开设置面板里的「Anywhere API」标签页**。
- **设置页**（`settings.section`，id `anywhere-gateway`，排在「账号与余额」之后）：
  未登录是一张介绍卡片（官方插画 44px + 标题 24px + 团队署名、一句说明、
  「一键配置」+「打开官网」、分割线、三条 ✓ 要点）；登录后是账号卡片 + 余额卡片 +
  账户概览（近 24 小时用量 / 总用量 / 请求总数）+「打开管理台」与「退出登录」。

> 显示名统一用「Anywhere 模型网关」；设置导航行因为列宽窄、用短名「Anywhere API」
> （字典键 `navShort`）。包名与目录名沿用 `dsh-plugin-anywhere-api`。

## 当前状态

- **登录/退出已接真实后端**（依据桌面上的《Anywhere 模型网关：DSH 插件后端接入说明》，2026-09-30）：
  OAuth 授权码 + PKCE，系统浏览器 + `127.0.0.1` loopback 回调，全部在 **Host 半边**完成；
  页面只读 Host 给的展示快照，**不持有任何 token**。
- 账号余额 / 总用量 / 请求总数 / 近 24 小时用量来自 `/api/user/self`、`/api/status`、
  `/api/log/self/stat`，失败时卡片上显示原因。
- 「一键配置」触发登录（等待期间按钮变为「等待浏览器中完成授权…」并禁用）；
  「退出登录」先调 `/api/oauth-server/revoke` 再清本地记录，网关不可达时退回本地退出并提示。
- 所有跳转都从**一个根地址**派生（见下），当前默认 `https://anywhere-api.com`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 清单：`dsh.bundle.patch` + `dsh.client` 声明 + `icon` |
| `cordis.patch.yml` | 向 profile 组合插入 `anywhere-gateway` 这一行 |
| `index.js` | Host 半边：OAuth + 凭据存储 + 用户接口 + 退出，并暴露同源账号路由 |
| `client.js` | Web Client 半边：两个插槽的注册、文案字典、样式、Host 状态订阅 |
| `locale/{en,zh}.json` | 插件管理页展示用的标题与描述 |
| `plugin-artwork-default.svg` | 插件图标（官方 `PluginArtworkDefault` 的静态导出，见下） |

## 实现要点

- 两个表面通过一个 `hooks` 观测对象共享账号状态（同一次 `apply` 里创建，交给两处注册）。
- 侧边栏卡片注册在 `sidebar.footer.action`，`order: 100` 让它排在其它 footer action（远程控制是
  26）之后，即 footer 区域的最后一个条目。再往下那一行是宿主的 single 插槽 `sidebar.settings`
  （官方账号/设置入口），第三方不能占用。
- 侧边栏卡片是 `Tooltip` → 行容器 → 官方 `Button`（`variant="ghost"`），几何与 AA
  「远程控制」条目逐条对齐（`width: calc(100% + 4px)`、`margin: 4px -2px`、42px 高、
  12px 圆角、`font: var(--dsw-font-s-14)`）；收窄成竖条时 36px 圆形图标、`margin: 8px 0 10px`。
- **控件与图像一律用官方组件**（基线模块 `@deepseek-ai/dsh-client-ui-primitives`）：`Button`
  （primary / outline / ghost）、`Tag`（outline / success）、`Tooltip`、
  `IconCheckOutlineRegular`、`IconGaugeOutlineRegular`、`IconRightUpOutlineRegular`、
  `PluginArtworkDefault`。本插件不自造按钮、标签、提示气泡或图标。
- **卡片 → 设置页**：DSH 没有设置分区的深链 API（`settings.section` 只给 `close`，
  `openSection` 只给 onboarding 步骤），所以 `openGatewaySettings()` 按 `data-slot` 驱动官方
  设置入口（含侧边栏账号菜单里那一项），再按本插件自己注册的标签选中目标页——与
  `dsh-desktop-next` 的原生设置请求同一套做法。**标签文案必须与它匹配**（`navShort`）。
- 样式只在 `apply` 里注入一次（`ctx.effect` + `<style>`，插件卸载时移除）。早期版本把
  `<style>` 放在设置页组件里，离开该页样式即丢失，侧边栏卡片会退化成无样式的官方按钮。
- 卡片与「远程控制」等其它 footer action 是同一个**列表插槽**的不同单元格，用各自的 `id`
  共存（复用别人的 `id` 才会顶替）。

### 仍然自己写样式的部分（官方组件目录里没有对应组件）

| 手写内容 | 原因 |
| --- | --- |
| 卡片容器 `.dsapi-card`（填充 / 描边 / 圆角 / 内边距） | `ui-primitives` 没有 Card 组件；官方设置页（如 `ui-settings-account`）同样自带 CSS Module 画卡片 |
| 分割线 `.dsapi-divider` | 没有 Divider 组件；官方页面同样是一行 `border-top` |
| 头像 `.dsapi-avatar` | 没有 Avatar 组件；官方账号页自带 `AccountAvatar` |
| 排版与栅格（`.dsapi-root`、`.dsapi-row`、`.dsapi-stats`、`.dsapi-stat*`、`.dsapi-points*`、`.dsapi-stack`） | 布局不属于原子组件；颜色与圆角全部走 `--dsw-*` token，字号走官方 token |
| footer 行的几何覆盖（`.dsapi-footTrigger` / `.dsapi-footRail` / `.dsapi-footButton`） | 官方 footer action 条目（AA、`ui-cordis`）都要自己覆写行几何，插件侧无法通过插槽参数拿到 |

### Host 半边的账号接口（`index.js`）

页面只认这三个同源路由，token 一律不出 Host：

| 路由 | 作用 |
| --- | --- |
| `GET /anywhere-gateway-api/state` | 展示快照：`{ signedIn, pending, profile, balance, totalSpend, totalRequests, last24h, error }` |
| `POST /anywhere-gateway-api/login` | 启动一次授权（并发点击只跑一次），立即返回 `202`，页面轮询 `state` |
| `POST /anywhere-gateway-api/logout` | 调 `revoke` 后清理本地记录，返回 `{ signedIn: false, confirmed }` |

流程要点（与后端文档逐条对应）：

- PKCE：`code_verifier` 48 字节 base64url（64 字符，字符合法），`code_challenge = BASE64URL(SHA256(verifier))` 无填充；`state` 24 字节随机，每次登录都换新。
- 回调：`http://127.0.0.1:<临时端口>/callback`（注册用 `:0`，请求用实际端口；主机名固定 `127.0.0.1`，不能用 `localhost`）。校验 `state` 与 `iss`，成功即回写一张"已登录，请回到 DSH"的页面并关掉监听。授权码 2 分钟有效，**不重试已发出的兑换**。
- 凭据：官方 `credentials` 服务的 **grant 记录**（`CREDENTIAL_KEY = anywhere-gateway`），payload 只有本插件解释。
- 刷新：过期前 60 秒主动刷新；单飞（`currentAccessToken` 内串行），旧 refresh token 立即被响应里的新值替换。
- `AUTH_TOKEN_EXPIRED` → 刷新后重试一次；`AUTH_SESSION_REVOKED` → 清记录并提示重新登录；业务失败可能是 HTTP 200 + `success:false`，也要当失败处理。
- User-Agent 固定为 `DSH Anywhere plugin`，便于用户在网站会话列表里认出这台设备。

### 网关地址（一个配置点）

**当前是临时开发地址**，两侧必须一起改：

```js
// index.js（Host：OAuth 与所有 API 调用）
const BASE_URL = 'https://localhost:8443'   // 生产为 https://anywhere-api.com
// client.js（页面里的跳转链接）
const WEB_BASE = 'https://localhost:8443'   // 必须与 BASE_URL 一致
const PAGES = { site: '/', console: '/dashboard', wallet: '/wallet', usage: '/usage-logs', profile: '/profile' }
```

本地服务用的是**自签名证书**，Node 默认会拒绝握手。所以 Host 的网关请求不走 `fetch`，而是
`node:https` + 一个 keep-alive agent：**只当 `BASE_URL` 是 loopback（`localhost` / `127.0.0.1`）
时才把 `rejectUnauthorized` 置 false**，绝不用 `NODE_TLS_REJECT_UNAUTHORIZED` 污染整个进程。
换回生产域名后该开关自动失效（正则 `RELAX_TLS` 不再匹配）。

`pageUrl(page)` 拼绝对地址，`openExternal(url)` 交给宿主决定新窗口还是系统浏览器。路径取自
anywhere-api 自己的 Web 路由（`web/src/routes/`，TanStack 文件路由；`_authenticated` 是无路径
布局，不进 URL，且未登录访问会重定向到登录页）：

| 按钮 | 页面 |
| --- | --- |
| 打开官网（未登录卡片） | `/` |
| 打开管理台（已登录） | `/dashboard` |
| 充值 | `/wallet` |
| 查询用量 | `/usage-logs` |
| 更多账号信息 | `/profile` |

### 关于图标

- 界面里（设置页卡片 44px、侧边栏卡片 24px）用官方 `PluginArtworkDefault` **组件**，
  随上游更新自动跟随。
- 插件清单图标（插件页/市场那张）必须是**文件**，所以 `plugin-artwork-default.svg` 是同一张
  官方插画（`ui-primitives` 的 `src/plugin-artwork.tsx`）的静态导出，仅把 `useArtworkId()`
  生成的渐变 id 固定下来。**这是官方素材的副本，上游重画时需要手动同步。**

## 已知限制

- **设置导航行拿不到自定义图标**：宿主的 `navIcon(id)` 是按 shipped section id 写死的映射，
  `settings.section` 的注册参数只有 `id` / `order` / `label`，第三方 section 一律落到兜底齿轮。
  （运行版里 `desktop` 之所以有显示器图标，是因为本仓库用
  `patches/dsh-client-ui-settings-general@<ver>.patch` 给宿主包打了个补丁，补丁注释也写着
  "kept local until the upstream slot accepts icons"。那是发行级改动，不是插件能力。）
- **打开设置页要驱动宿主 UI**：见上文的 `openGatewaySettings()`，这段逻辑随宿主 UI 变化需要
  回归；官方若给 `settings.section` 加深链能力，应立刻换掉。
- 「一键配置」与「退出登录」已接真实接口，见上文 Host 账号接口。
- 侧边栏收窄（56px 竖条）状态未做人工视觉确认。

### 已试过并撤回的方案（留档，避免重复踩坑）

| 方案 | 撤回原因 |
| --- | --- |
| 主区域整页（`main` 键位插槽 + `ctx.layout.selectPanel`） | 形态是"接管右侧整页"，用户不要；改回点击卡片直接打开设置标签页 |
| 照抄官网落地页（左右分栏 + 右侧配图 + 大标题） | 视觉不符；配图还需要 Host 半边注册 `/anywhere-gateway-assets` 静态路由（客户端模块路由只暴露 client bundle，插件自带文件必须自己开路由） |
| 设置页内容列包一层"设置弹窗同款面板外壳" | 被否，不要照搬宿主的面板 chrome |

## 安装到本地 profile（开发）

```text
plugin_manager { action: "install_bundle", target: "<仓库绝对路径>/dsh-plugin-anywhere-api" }
```

profile 会以 `link:` 指向该目录，改 `client.js` 保存即生效（无需重启）。

## 待办

- 端到端联调：后端文档说明 `dsh-plugin-anywhere-api` 这个 OAuth 客户端**只是配置模板、未确认已在线上注册**，
  且新版后端尚未部署；首次联调要先确认 `OAUTH_SERVER_CLIENTS` 里有它。
- 让网关的 OpenAI 兼容端点出现在「模型」页（可复用 `dsh-llm-pi-ai` 的 OpenAI 兼容路由），
  并把模型 API Key 存进官方凭据存储（文档第 3 节的要求）。
- 顶栏余额/用量随会话刷新（目前进入设置页或打开面板时拉取一次）。
