/**
 * Web Client half of the Anywhere 模型网关 plugin.
 *
 * Two surfaces share one account state:
 * - the settings page (`settings.section`) with the full account, balance, and usage cards;
 * - the sidebar-foot card (`sidebar.footer.action`) that summarizes the state and opens
 *   the settings page.
 *
 * Controls and artwork are the official atoms from the baseline module-table package
 * `@deepseek-ai/dsh-client-ui-primitives`; this file owns only layout and the card
 * containers no primitive covers. Account state is a local mock for now: the Host half
 * will own the real token, balance, and usage reads.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-anywhere-api',
  factory(require) {
    const React = require('react')
    const {
      Button,
      Tag,
      Tooltip,
      IconCheckOutlineRegular,
      IconCloseOutlineRegular,
      IconGlobeOutlineRegular,
      IconRightUpOutlineRegular,
      PluginArtworkDefault,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Copy for both shipped locales; the framework re-reads it on a locale switch. */
    const DICTIONARIES = {
      zh: {
        nav: 'Anywhere 模型网关',
        // The settings nav column is narrow and truncates a long label, so the nav row uses
        // the short product abbreviation while every wide surface keeps the full name.
        navShort: 'Anywhere API',
        signInTo: '登录到 Anywhere 模型网关',
        promoTitle: 'Anywhere 模型网关',
        panelSub: 'DSH Next 团队提供',
        panelLede: '一个密钥接入主流模型，余额与用量随账号同步。',
        setup: '一键配置',
        pending: '等待浏览器中完成授权…',
        openSite: '打开官网',
        point1: '一个 API，统一接入多家主流 AI 模型',
        point2: '一键导入到 Agents Anywhere 和 DSH Desktop，快速开始使用',
        point3: '请求记录与用量统计，随时查看调用情况',
        connected: '已连接',
        accountInfo: '更多账号信息',
        balance: '余额',
        usageLabel: '今日用量',
        topUp: '充值',
        usage: '查询用量',
        more: '更多',
        overview: '账户概览',
        last24h: '近 24 小时用量',
        totalUsage: '总用量',
        totalRequests: '请求总数',
        console: '打开管理台',
        signOut: '退出登录',
        configure: '配置模型供应商',
        configuring: '正在配置模型…',
        configured: '模型供应商已配置',
        dismiss: '关闭提示',
      },
      en: {
        nav: 'Anywhere Model Gateway',
        navShort: 'Anywhere API',
        signInTo: 'Sign in to Anywhere Model Gateway',
        promoTitle: 'Anywhere Model Gateway',
        panelSub: 'Provided by the DSH Next team',
        panelLede: 'One key for the mainstream models, with balance and usage in sync.',
        setup: 'One-click setup',
        pending: 'Waiting for the browser…',
        openSite: 'Open site',
        point1: 'One API for the mainstream AI models',
        point2: 'One-click import into Agents Anywhere and DSH Desktop',
        point3: 'Request logs and usage statistics, always up to date',
        connected: 'Connected',
        accountInfo: 'More account information',
        balance: 'Balance',
        usageLabel: 'Today',
        topUp: 'Top up',
        usage: 'Query usage',
        more: 'More',
        overview: 'Account overview',
        last24h: 'Last 24 hours',
        totalUsage: 'Total usage',
        totalRequests: 'Total requests',
        console: 'Open console',
        signOut: 'Sign out',
        configure: 'Configure model provider',
        configuring: 'Configuring models…',
        configured: 'Model provider configured',
        dismiss: 'Dismiss notification',
      },
    }

    /**
     * Layout and card containers only — every control, tag, tooltip, and glyph on these
     * surfaces is an official primitive, and all color/radius values are `--dsw-*` tokens.
     * The sidebar-foot geometry mirrors the shipped footer entries.
     */
    const STYLES = `
.dsapi-root{display:flex;flex-direction:column;gap:22px;padding:8px 0;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsapi-lede{max-width:440px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.dsapi-panelHead{display:flex;align-items:center;gap:12px}
.dsapi-panelHeadCopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsapi-panelTitle{font:var(--dsw-font-xl-24)}
.dsapi-panelSub{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsapi-panelActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* Official sign-in geometry: ui-settings-account's primary login action is the same
   primary Button with min-width 72px and weight 500. */
.dsapi-signIn{min-width:72px;font-weight:500}
.dsapi-openSite{gap:6px}
.dsapi-points{display:flex;flex-direction:column;gap:12px}
.dsapi-point{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.dsapi-pointIcon{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.dsapi-card{padding:16px 18px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.dsapi-divider{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsapi-error{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dsapi-errorText{flex:1;min-width:0;overflow-wrap:anywhere}
.dsapi-errorClose{flex:none;color:inherit}
.dsapi-hero{display:flex;flex-direction:column;gap:14px}
.dsapi-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsapi-stack{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.dsapi-block{width:100%}
.dsapi-muted{color:var(--dsw-alias-label-tertiary)}
.dsapi-identity{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsapi-identityMain{display:flex;align-items:center;gap:10px;min-width:0}
.dsapi-avatar{position:relative;overflow:hidden;flex:none;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:500}
.dsapi-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%}
.dsapi-name{font-size:14px;font-weight:500}
.dsapi-status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsapi-balance{display:flex;flex-direction:column;gap:12px}
.dsapi-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;padding:8px 0;box-sizing:border-box}
.dsapi-amount{font-size:18px;line-height:28px;font-weight:510}
.dsapi-sectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.dsapi-stats{display:flex;gap:14px;flex-wrap:wrap}
.dsapi-stat{flex:1 1 120px;min-width:110px;padding:14px 16px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsapi-statLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsapi-statValue{font-size:16px;line-height:24px;font-weight:500}
.dsapi-footTrigger{display:flex;width:calc(100% + 4px);min-width:0;margin:4px -2px}
.dsapi-footTrigger :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.dsapi-footTrigger .dsapi-footButton{width:100%;height:42px;font:var(--dsw-font-s-14);border-radius:12px;justify-content:flex-start;gap:8px;padding:0 10px 0 8px}
.dsapi-footRail{width:36px;margin:8px 0 10px}
.dsapi-footRail .dsapi-footButton{border-radius:50%;justify-content:center;height:36px;padding:0}
.dsapi-footLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsapi-footStats{display:flex;align-items:baseline;gap:14px;flex:1 1 auto;min-width:0;overflow:hidden}
.dsapi-footStat{display:inline-flex;align-items:baseline;gap:4px;min-width:0;white-space:nowrap}
.dsapi-footStatLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsapi-footStatValue{font-size:13px;line-height:18px;font-variant-numeric:tabular-nums}
.dsapi-footMark{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px}
`

    /**
     * The Host half's account routes (see `index.js`): the page never holds a token, it reads
     * the display snapshot the Host builds and asks the Host to sign in or out.
     */
    const API_BASE = '/anywhere-gateway-api'

    /** How often a pending authorization is re-checked. */
    const POLL_MS = 1200

    /** How often the account figures are refreshed while signed in. */
    const IDLE_MS = 60_000

    /** Repeated triggers (panel mounts, focus) closer than this are coalesced. */
    const MIN_GAP_MS = 10_000

    /**
     * One shared account state for both surfaces. `getSnapshot` keeps the same reference until
     * the Host reports a change, which is what the framework's observable hook requires.
     * @returns the observable plus the sign-in, sign-out, and refresh actions.
     */
    function createGatewayState() {
      let snapshot = { signedIn: false, pending: false, loading: true, errors: [], dismissedErrors: [] }
      const listeners = new Set()
      let timer
      let lastReadAt = 0
      const publish = change => {
        snapshot = { ...snapshot, ...change }
        const errors = [...new Set([
          snapshot.error,
          snapshot.signedIn && snapshot.setup?.status !== 'ready' ? snapshot.setup?.error : undefined,
        ].filter(Boolean))]
        // Retain dismissal across polling and panel mounts, only while the error persists.
        snapshot.dismissedErrors = snapshot.dismissedErrors.filter(error => errors.includes(error))
        snapshot.errors = errors.filter(error => !snapshot.dismissedErrors.includes(error))
        for (const listener of [...listeners]) listener()
      }
      const stopPolling = () => {
        if (timer === undefined) return
        window.clearTimeout(timer)
        timer = undefined
      }
      const readState = async () => {
        try {
          const response = await fetch(`${API_BASE}/state`, { headers: { accept: 'application/json' } })
          const text = await response.text()
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = undefined
          }
          if (body === undefined) {
            // A non-JSON answer is the page fallback, not this plugin: the Host half has not
            // been loaded in this process yet.
            publish({
              loading: false,
              pending: false,
              error: `插件主机未就绪（HTTP ${response.status}），重启 DSH 后重试`,
            })
            return undefined
          }
          lastReadAt = Date.now()
          publish({ ...body, loading: false })
          return body
        } catch {
          publish({ loading: false, pending: false, error: '无法连接插件主机' })
          return undefined
        }
      }
      // Signed in, the figures keep moving: keep a slow timer instead of stopping after the
      // authorization settles, and pause it while the window is hidden.
      const poll = async () => {
        timer = undefined
        const body = await readState()
        if (document.visibilityState === 'hidden') return
        timer = window.setTimeout(() => { void poll() }, body?.pending === true ? POLL_MS : IDLE_MS)
      }
      return {
        getSnapshot: () => snapshot,
        dismissError(error) {
          publish({ dismissedErrors: [...snapshot.dismissedErrors, error] })
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /**
         * Read the Host's current account state now.
         * @param force - bypass the coalescing gap, for events that must not show stale data.
         */
        async refresh(force = false) {
          if (!force && lastReadAt !== 0 && Date.now() - lastReadAt < MIN_GAP_MS) return
          stopPolling()
          await poll()
        },
        /** Ask the Host to run the OAuth flow, then follow it until it settles. */
        async signIn() {
          publish({ error: undefined, pending: true, dismissedErrors: [] })
          try {
            const response = await fetch(`${API_BASE}/login`, { method: 'POST' })
            if (!response.ok) {
              publish({ pending: false, error: `插件主机未接受登录请求（HTTP ${response.status}）` })
              return
            }
          } catch {
            publish({ pending: false, error: '无法连接插件主机' })
            return
          }
          stopPolling()
          void poll()
        },
        /** Revoke on the gateway and drop the local grant. */
        async signOut() {
          stopPolling()
          try {
            const response = await fetch(`${API_BASE}/logout`, { method: 'POST' })
            const body = await response.json()
            publish({ signedIn: false, pending: false, profile: undefined, error: undefined })
            if (body?.confirmed === false) {
              publish({ error: '已在本地退出；网关未确认撤销，请稍后在网站会话列表确认' })
            }
          } catch {
            publish({ signedIn: false, pending: false, error: '已在本地退出；未能连接网关' })
          }
          await readState()
        },
        async configure() {
          if (snapshot.configuring) return
          publish({ configuring: true, error: undefined, dismissedErrors: [] })
          try {
            const response = await fetch(`${API_BASE}/configure`, { method: 'POST' })
            const body = await response.json()
            if (!response.ok) publish({ error: body.error ?? '模型配置失败 / Model setup failed' })
          } catch {
            publish({ error: '无法连接插件主机 / Cannot reach plugin host' })
          } finally {
            publish({ configuring: false })
            await readState()
          }
        },
        /** Stop polling when the plugin unloads. */
        dispose() {
          stopPolling()
        },
      }
    }

    /**
     * Gateway Web root: one place to change for a different deployment.
     */
    // TEMPORARY: the local development server. Production is 'https://anywhere-api.com'.
    // Must move together with BASE_URL in index.js.
    const WEB_BASE = 'https://localhost:8443'

    /**
     * Pages of the gateway console, relative to `WEB_BASE` — the routes the Web app itself
     * declares (TanStack file routes under `web/src/routes/`; its `_authenticated` layout is
     * pathless, so it contributes no URL segment and redirects to sign-in when signed out).
     */
    const PAGES = {
      /** Public site. */
      site: '/',
      /** Signed-in dashboard. */
      console: '/dashboard',
      /** Wallet and top-up. */
      wallet: '/wallet',
      /** Request logs and usage statistics. */
      usage: '/usage-logs',
      /** Account profile. */
      profile: '/profile',
    }

    /**
     * Absolute URL of one gateway page.
     * @param page - key of `PAGES`.
     * @returns the absolute URL.
     */
    function pageUrl(page) {
      return `${WEB_BASE}${PAGES[page]}`
    }

    /**
     * Open a gateway page outside the app; the DSH host decides whether that is a new window
     * or the system browser.
     * @param url - absolute URL to open.
     */
    function openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }

    /** Whether an element is actually laid out (closed menus keep their items in the tree). */
    function isVisible(element) {
      return element.getClientRects().length > 0
    }

    /**
     * The Settings entry of the open sidebar launcher menu, or null while it is closed.
     * @returns the clickable entry, preferring one that names Settings.
     */
    function settingsMenuItem() {
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(isVisible)
      if (menu === undefined) return null
      const items = Array.from(menu.querySelectorAll('[role="menuitem"], button, a')).filter(isVisible)
      if (items.length === 0) return null
      return items.find(item => ['设置', 'Settings'].includes((item.textContent ?? '').trim())) ?? items[0]
    }

    /**
     * Open the settings panel on this plugin's own section.
     *
     * DSH publishes no deep link to a settings section, so this drives the official launcher by
     * its `data-slot` identity and then selects the page by the label this plugin itself
     * registered — the technique dsh-desktop-next uses for its native settings requests. Every
     * step is retried on animation frames: the launcher menu and the settings modal both mount
     * asynchronously.
     * @param label - this plugin's localized settings label.
     */
    function openGatewaySettings(label) {
      const dialog = () => document.querySelector('[data-shortcut-modal="settings"]')
      const findOurRow = () => {
        const nav = dialog() === null ? null : dialog().querySelector('nav')
        if (nav === null) return null
        return Array.from(nav.querySelectorAll('button'))
          .find(button => (button.textContent ?? '').trim() === label) ?? null
      }
      const selectOurRow = () => {
        const row = findOurRow()
        if (row === null) return false
        row.click()
        return true
      }
      if (selectOurRow()) return

      let frames = 0
      let launcherOpened = false
      let menuChosen = false
      const step = () => {
        if (selectOurRow()) return
        if (frames++ > 180) return
        if (dialog() === null) {
          if (!launcherOpened) {
            const trigger = document.querySelector('[data-slot="settings.trigger"]')
            const launcher = document.querySelector('[data-slot="settings.launcher"]')
            const target = (trigger === null ? null : trigger.closest('button'))
              ?? (launcher === null ? null : launcher.querySelector('button'))
              ?? launcher
            if (target !== null) {
              launcherOpened = true
              target.click()
            }
          } else if (!menuChosen) {
            const item = settingsMenuItem()
            if (item !== null) {
              menuChosen = true
              item.click()
            }
          }
        }
        window.requestAnimationFrame(step)
      }
      step()
    }

    /**
     * The signed-out invitation to the gateway, as the settings promo card.
     */
    function SignedOutPanel({ t, account, onSignIn }) {
      const openSite = () => { openExternal(pageUrl('site')) }
      // Both actions are the official Button; the trailing glyph follows the account page's
      // external-link treatment (arrow after the label, 12px).
      const siteButton = h(
        Button,
        { variant: 'outline', className: 'dsapi-openSite', onClick: openSite },
        h('span', null, t('openSite')),
        h(IconRightUpOutlineRegular, { size: 12 }),
      )
      const body = [
        h(
          'div',
          { className: 'dsapi-panelHead', key: 'head' },
          h(PluginArtworkDefault, { size: 44 }),
          h(
            'div',
            { className: 'dsapi-panelHeadCopy' },
            h('div', { className: 'dsapi-panelTitle' }, t('promoTitle')),
            h('div', { className: 'dsapi-panelSub' }, t('panelSub')),
          ),
        ),
        h('div', { className: 'dsapi-lede', key: 'lede' }, t('panelLede')),
        h(
          'div',
          { className: 'dsapi-panelActions', key: 'actions' },
          h(
            Button,
            {
              variant: 'primary',
              className: 'dsapi-signIn',
              onClick: onSignIn,
              disabled: account?.pending === true,
            },
            account?.pending === true ? t('pending') : t('setup'),
          ),
          siteButton,
        ),
        h('div', { className: 'dsapi-divider', key: 'divider' }),
        h(
          'div',
          { className: 'dsapi-points', key: 'points' },
          [t('point1'), t('point2'), t('point3')].map(text => h(
            'div',
            { className: 'dsapi-point', key: text },
            h('span', { className: 'dsapi-pointIcon' }, h(IconCheckOutlineRegular, { size: 16 })),
            h('span', null, text),
          )),
        ),
      ]
      return h('div', { className: 'dsapi-card dsapi-hero' }, body)
    }

    /** The signed-in account, balance, and usage cards. */
    function SignedInPanel({ t, account, onSignOut, onConfigure }) {
      const stat = (label, value) => h(
        'div',
        { className: 'dsapi-stat', key: label },
        h('div', { className: 'dsapi-statLabel' }, label),
        h('div', { className: 'dsapi-statValue' }, value),
      )
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsapi-card dsapi-identity' },
          h(
            'div',
            { className: 'dsapi-identityMain' },
            h(
              'span',
              {
                className: 'dsapi-avatar',
                // Inline geometry on purpose: an avatar that renders as a bare square means the
                // styling never reached the element, and inline styles cannot be lost to a stale
                // injected sheet or a host rule that wins the cascade.
                style: {
                  position: 'relative',
                  overflow: 'hidden',
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                },
              },
              (account.profile?.name ?? '?').slice(0, 1),
              // The picture rides on top of the initial; a broken URL just removes itself.
              typeof account.profile?.avatar === 'string' && account.profile.avatar !== ''
                ? h('img', {
                  src: account.profile.avatar,
                  alt: '',
                  style: {
                    position: 'absolute',
                    top: '0',
                    left: '0',
                    width: '32px',
                    height: '32px',
                    objectFit: 'cover',
                    borderRadius: '50%',
                    display: 'block',
                  },
                  onError: event => { event.currentTarget.remove() },
                })
                : null,
            ),
            h(
              'div',
              null,
              h('div', { className: 'dsapi-name' }, account.profile?.name ?? ''),
              h(
                'div',
                { className: 'dsapi-status' },
                account.profile?.id === undefined ? '' : `ID ${account.profile.id}`,
                h(Tag, { tone: 'success' }, t('connected')),
              ),
            ),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              icon: h(IconRightUpOutlineRegular, { size: 12 }),
              onClick: () => { openExternal(pageUrl('profile')) },
            },
            t('accountInfo'),
          ),
        ),
        h(
          'div',
          { className: 'dsapi-card dsapi-balance' },
          h('div', { className: 'dsapi-row' }, h('span', null, t('balance')), h('span', { className: 'dsapi-amount' }, account.balance ?? '—')),
          h('div', { className: 'dsapi-divider' }),
          h(
            'div',
            { className: 'dsapi-row' },
            h('span', { className: 'dsapi-muted' }, t('more')),
            h(
              'div',
              { className: 'dsapi-actions' },
              h(Button, { variant: 'outline', onClick: () => { openExternal(pageUrl('usage')) } }, t('usage')),
              h(Button, { variant: 'primary', onClick: () => { openExternal(pageUrl('wallet')) } }, t('topUp')),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsapi-card' },
          h(
            'div',
            { className: 'dsapi-sectionHead' },
            h('span', null, t('overview')),
            h('span', { className: 'dsapi-muted' }, account.profile?.id === undefined ? '' : `ID ${account.profile.id}`),
          ),
          h(
            'div',
            { className: 'dsapi-stats' },
            [
              [t('last24h'), account.last24h ?? '—'],
              [t('totalUsage'), account.totalSpend ?? '—'],
              [t('totalRequests'), account.totalRequests ?? '—'],
            ].map(([label, value]) => stat(label, value)),
          ),
        ),
        h(
          'div',
          { className: 'dsapi-stack' },
          h(Button, {
            variant: 'primary',
            size: 'md',
            className: 'dsapi-block',
            icon: h(IconGlobeOutlineRegular, { size: 16 }),
            onClick: () => { openExternal(pageUrl('console')) },
          }, t('console')),
          account.setup?.status === 'ready' ? null : h(Button, {
            variant: 'outline',
            size: 'md',
            className: 'dsapi-block',
            disabled: account.configuring || account.pending || account.setup?.status === 'working',
            onClick: onConfigure,
          }, account.configuring || account.pending || account.setup?.status === 'working'
            ? t('configuring') : t('configure')),
          h(Button, {
            variant: 'ghost',
            size: 'md',
            className: 'dsapi-block',
            onClick: onSignOut,
          }, t('signOut')),
        ),
      )
    }

    /** The settings page: one card per account state. */
    function SettingsPage(props) {
      const t = props.t
      const account = props.useGateway(snapshot => snapshot)
      // Opening the settings section is the clearest signal that the user wants current numbers.
      React.useEffect(() => { props.refresh() }, [])
      return h(
        'section',
        { className: 'dsapi-root', 'aria-label': t('nav') },
        account.errors.map(error => h(
          'div',
          { className: 'dsapi-error', role: 'alert', key: error },
          h('span', { className: 'dsapi-errorText' }, error),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'dsapi-errorClose',
            icon: h(IconCloseOutlineRegular, { size: 16 }),
            'aria-label': t('dismiss'),
            onClick: () => { props.dismissError(error) },
          }),
        )),
        account.signedIn
          ? h(SignedInPanel, { t, account, onSignOut: props.signOut, onConfigure: props.configure })
          : h(SignedOutPanel, { t, account, onSignIn: props.signIn }),
      )
    }


    /** One footer stat (label above value). */
    function FootStat({ label, value }) {
      return h(
        'span',
        { className: 'dsapi-footStat' },
        h('span', { className: 'dsapi-footStatLabel' }, label),
        h('span', { className: 'dsapi-footStatValue' }, value),
      )
    }

    /**
     * The sidebar-foot card: a sign-in invitation, or the avatar with balance and usage.
     * Mirrors the shipped footer entries — an official `Tooltip` around an official ghost
     * `Button` — overriding only the row geometry, which those entries do too.
     * @param props - composed slot props (`wide` is the sidebar column state).
     */
    function FooterCard(props) {
      const t = props.t
      const wide = props.wide
      const account = props.useGateway(snapshot => snapshot)
      const signedIn = account.signedIn
      const summary = `${t('balance')} ${account.balance ?? '—'} · ${t('usageLabel')} ${account.last24h ?? '—'}`
      const label = signedIn ? summary : t('signInTo')
      // The gateway mark leads both states: the shipped footer entries are icon + text, and
      // the account row directly below already owns the user's avatar.
      const mark = h(PluginArtworkDefault, { size: 24, className: 'dsapi-footMark', key: 'mark' })
      const stats = h(
        'span',
        { className: 'dsapi-footStats', key: 'stats' },
        h(FootStat, { label: t('balance'), value: account.balance ?? '—' }),
        h(FootStat, { label: t('usageLabel'), value: account.last24h ?? '—' }),
      )
      const children = signedIn
        ? wide ? [mark, stats] : [mark]
        : wide ? [mark, h('span', { className: 'dsapi-footLabel', key: 'label' }, t('nav'))] : [mark]
      return h(
        Tooltip,
        { label, disabled: wide, delayMs: 500 },
        h(
          'span',
          { className: wide ? 'dsapi-footTrigger' : 'dsapi-footTrigger dsapi-footRail' },
          h(
            Button,
            {
              variant: 'ghost',
              className: 'dsapi-footButton',
              'aria-label': label,
              'aria-haspopup': 'dialog',
              onClick: props.openSettings,
            },
            children,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind('anywhere-gateway')
        const gateway = createGatewayState()
        // One stable inject face per registration: the renderer caches the bound hooks by identity.
        const sectionFace = {
          hooks: { gateway },
          signIn: () => { void gateway.signIn() },
          signOut: () => { void gateway.signOut() },
          configure: () => { void gateway.configure() },
          dismissError: error => { gateway.dismissError(error) },
          refresh: () => { void gateway.refresh() },
        }
        const footerFace = {
          hooks: { gateway },
          // Must match the settings row's label: the row is found by its visible text.
          openSettings: () => { openGatewaySettings(t('navShort')) },
        }
        // Plugin-owned sheet: mounted with the plugin, so both surfaces keep their layout
        // whether or not the settings page has ever rendered.
        ctx.effect(() => {
          const sheet = document.createElement('style')
          sheet.textContent = STYLES
          document.head.appendChild(sheet)
          return () => { sheet.remove() }
        }, 'anywhere-gateway: styles')
        ctx.effect(() => ctx.locale.register('anywhere-gateway', DICTIONARIES), 'anywhere-gateway: dictionaries')
        // Refresh triggers: plugin load, returning focus (for example after authorizing in the
        // browser), and coming back from a hidden window. The state module coalesces them and
        // keeps a slow timer of its own, so the sidebar figures stay current without polling
        // the gateway hard. Everything is removed when the plugin unloads.
        ctx.effect(() => {
          const onFocus = () => { void gateway.refresh() }
          const onVisibility = () => {
            if (document.visibilityState === 'visible') void gateway.refresh()
          }
          window.addEventListener('focus', onFocus)
          document.addEventListener('visibilitychange', onVisibility)
          void gateway.refresh(true)
          return () => {
            window.removeEventListener('focus', onFocus)
            document.removeEventListener('visibilitychange', onVisibility)
            gateway.dispose()
          }
        }, 'anywhere-gateway: account state')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'anywhere-gateway',
          order: -5,
          label: () => t('navShort'),
          locale: 'anywhere-gateway',
          inject: () => sectionFace,
        }, SettingsPage))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'anywhere-gateway',
          // Last footer entry: the sidebar orders footer actions ascending, and the account
          // row below them is the host's single `sidebar.settings` cell.
          order: 100,
          label: () => t('nav'),
          locale: 'anywhere-gateway',
          inject: () => footerFace,
        }, FooterCard))
      },
    }
  },
})
