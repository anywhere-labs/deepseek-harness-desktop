/** Desktop-only recovery controls injected into the framework-free boot page. */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DESKTOP_DIAGNOSTICS_EXPORT_PATH,
  DESKTOP_PROFILE_CREATE_WINDOW_PATH,
  DESKTOP_PROFILE_ROLLBACK_PATH,
  DESKTOP_PROFILE_SELECT_PATH,
  DESKTOP_SETTINGS_PATH,
  DESKTOP_TERMINAL_OPEN_PATH,
} from './desktop-settings-contract.ts'

/** The bounded same-origin request shared by empty Desktop recovery actions. */
export const DESKTOP_TERMINAL_OPEN_REQUEST = Object.freeze({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  credentials: 'same-origin',
})

/** Official boot-page-aligned presentation for the early recovery controls. */
export const DESKTOP_BOOT_RECOVERY_STYLE = `
[data-dsh-desktop-recovery] {
  --dsh-recovery-fg: var(--dsw-alias-label-primary, var(--dsh-boot-label-primary, #0f1115));
  --dsh-recovery-muted: var(--dsw-alias-label-secondary, var(--dsh-boot-label-secondary, #61666b));
  --dsh-recovery-border: var(--dsw-alias-border-l2, var(--dsh-boot-border, rgb(0 0 0 / 10%)));
  --dsh-recovery-hover: var(--dsw-alias-interactive-bg-hover, rgb(0 0 0 / 6%));
  --dsh-recovery-active: var(--dsw-alias-interactive-bg-active, rgb(0 0 0 / 10%));
  --dsh-recovery-primary-bg: var(--dsw-alias-button-primary-fill, var(--dsh-boot-brand, #0f1115));
  --dsh-recovery-primary-hover: var(--dsw-alias-button-primary-hover, #303238);
  --dsh-recovery-primary-fg: var(--dsw-alias-label-primary-foreground, #fff);
  width: min(480px, calc(100vw - 48px));
  margin-top: 16px;
  color: var(--dsh-recovery-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
[data-dsh-desktop-recovery] [data-dsh-recovery-actions],
[data-dsh-desktop-recovery] [data-dsh-recovery-profile-row],
[data-dsh-desktop-recovery] [data-dsh-recovery-confirm] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-dsh-desktop-recovery] [data-dsh-recovery-profile] {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--dsh-recovery-border);
}
[data-dsh-desktop-recovery] [data-dsh-recovery-label] {
  margin: 0 0 8px;
  color: var(--dsh-recovery-muted);
  font-size: 12px;
  line-height: 18px;
}
[data-dsh-desktop-recovery] button,
[data-dsh-desktop-recovery] select {
  min-height: 36px;
  background: transparent;
  color: var(--dsh-recovery-fg);
  font: 400 14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
[data-dsh-desktop-recovery] button {
  padding: 0 14px;
  border: 0;
  border-radius: 18px;
  cursor: pointer;
}
[data-dsh-desktop-recovery] select {
  min-width: 170px;
  flex: 1 1 170px;
  border: 1px solid var(--dsh-recovery-border);
  border-radius: 9px;
  padding: 7px 30px 7px 10px;
}
[data-dsh-desktop-recovery] button:hover:not(:disabled) { background: var(--dsh-recovery-hover); }
[data-dsh-desktop-recovery] button:active:not(:disabled) { background: var(--dsh-recovery-active); }
[data-dsh-desktop-recovery] button[data-primary] {
  background: var(--dsh-recovery-primary-bg);
  color: var(--dsh-recovery-primary-fg);
}
[data-dsh-desktop-recovery] button[data-primary]:hover:not(:disabled),
[data-dsh-desktop-recovery] button[data-primary]:active:not(:disabled) {
  background: var(--dsh-recovery-primary-hover);
}
[data-dsh-desktop-recovery] button:focus-visible,
[data-dsh-desktop-recovery] select:focus-visible {
  outline: 2px solid #5b8def;
  outline-offset: 2px;
}
[data-dsh-desktop-recovery] button:disabled,
[data-dsh-desktop-recovery] select:disabled { cursor: progress; opacity: 0.52; }
[data-dsh-desktop-recovery] [data-dsh-recovery-status] {
  min-height: 18px;
  margin: 9px 0 0;
  color: var(--dsh-recovery-muted);
  font-size: 12px;
  line-height: 18px;
}
[data-dsh-desktop-recovery] [data-dsh-recovery-confirm] {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--dsh-recovery-border);
  border-radius: 8px;
}
[data-dsh-desktop-recovery] [data-dsh-recovery-confirm][hidden] { display: none; }
[data-dsh-desktop-recovery] [data-dsh-recovery-confirm-text] {
  flex: 1 1 100%;
  margin: 0;
  color: var(--dsh-recovery-muted);
  font-size: 12px;
  line-height: 18px;
}
body[data-ds-dark-theme] [data-dsh-desktop-recovery] {
  --dsh-recovery-fg: #f9fafb;
  --dsh-recovery-muted: #cfd3d6;
  --dsh-recovery-border: rgb(255 255 255 / 18%);
  --dsh-recovery-hover: rgb(255 255 255 / 9%);
  --dsh-recovery-active: rgb(255 255 255 / 14%);
  --dsh-recovery-primary-bg: #f9fafb;
  --dsh-recovery-primary-hover: #dfe3e6;
  --dsh-recovery-primary-fg: #151517;
}
@media (prefers-color-scheme: dark) {
  [data-dsh-desktop-recovery] {
    --dsh-recovery-fg: #f9fafb;
    --dsh-recovery-muted: #cfd3d6;
    --dsh-recovery-border: rgb(255 255 255 / 18%);
    --dsh-recovery-hover: rgb(255 255 255 / 9%);
    --dsh-recovery-active: rgb(255 255 255 / 14%);
    --dsh-recovery-primary-bg: #f9fafb;
    --dsh-recovery-primary-hover: #dfe3e6;
    --dsh-recovery-primary-fg: #151517;
  }
}
@media (max-width: 520px) {
  [data-dsh-desktop-recovery] { width: calc(100vw - 32px); }
  [data-dsh-desktop-recovery] button,
  [data-dsh-desktop-recovery] select { flex: 1 1 100%; width: 100%; }
}
`

const ENDPOINTS = Object.freeze({
  settings: DESKTOP_SETTINGS_PATH,
  terminal: DESKTOP_TERMINAL_OPEN_PATH,
  diagnostics: DESKTOP_DIAGNOSTICS_EXPORT_PATH,
  rollback: DESKTOP_PROFILE_ROLLBACK_PATH,
  selectProfile: DESKTOP_PROFILE_SELECT_PATH,
  createProfile: DESKTOP_PROFILE_CREATE_WINDOW_PATH,
})

/** Add launcher-owned recovery controls after the upstream plugin failure report. */
export const DESKTOP_BOOT_RECOVERY_SCRIPT = `(() => {
  const endpoints = ${JSON.stringify(ENDPOINTS)};
  const request = ${JSON.stringify(DESKTOP_TERMINAL_OPEN_REQUEST)};
  const text = {
    terminal: '打开 DSH 终端 / Open DSH Terminal',
    diagnostics: '导出诊断 / Export Diagnostics',
    rollback: '运行回滚 / Run Rollback',
    confirmRollback: '确认回滚并重启 / Restore and Restart',
    cancel: '取消 / Cancel',
    profile: '切换配置 / Switch Profile',
    switchProfile: '切换并重启 / Switch and Restart',
    createProfile: '新建配置 / New Profile',
    loadingProfiles: '正在读取配置… / Loading Profiles…',
    noProfiles: '没有其他可用配置 / No other Profile is available',
    rollbackConfirm: '将保存诊断并恢复最近一次成功启动的 Profile 和配置，然后重新启动 DSH Desktop。 / Diagnostics will be saved before restoring the last successful Profile and configuration, then DSH Desktop will restart.',
    working: '正在处理，请稍候… / Working…',
    restarting: '操作已接受，DSH Desktop 正在重新启动… / Accepted. DSH Desktop is restarting…',
    diagnosticsDone: '诊断导出流程已打开。 / The diagnostic export flow opened.',
    creatorOpened: '新建配置窗口已打开。 / The Profile creator opened.',
    rollbackUnavailable: '没有可用的安全回滚，请切换配置或打开 DSH 终端。 / A safe rollback is unavailable. Switch Profile or open DSH Terminal.',
    failed: '操作暂时无法完成，请尝试其他恢复方式。 / The action is temporarily unavailable. Try another recovery option.',
    profilesFailed: '暂时无法读取配置列表。 / Profiles are temporarily unavailable.',
  };
  const element = (tag, attributes, content) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (name === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(name, value);
    }
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const post = async (endpoint, body = {}) => {
    const response = await fetch(endpoint, { ...request, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Desktop recovery request failed');
    return await response.json().catch(() => ({}));
  };
  const attach = () => {
    const root = document.querySelector('[data-dsh-boot]');
    if (!root || root.querySelector('[data-dsh-desktop-recovery]')) return;
    const title = [...root.querySelectorAll('div')].find((node) =>
      node.childElementCount === 0 && node.textContent?.trim() === 'Failed to load plugins'
    );
    const report = title?.parentElement;
    if (!report) return;
    const panel = element('section', { 'aria-label': 'DSH Desktop recovery', dataset: { dshDesktopRecovery: '' } });
    const actions = element('div', { dataset: { dshRecoveryActions: '' } });
    const status = element('p', { role: 'status', 'aria-live': 'polite', dataset: { dshRecoveryStatus: '' } }, '');
    const controls = [];
    const actionButton = (label, primary, run) => {
      const button = element('button', { type: 'button', ...(primary ? { 'data-primary': '' } : {}) }, label);
      controls.push(button);
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = text.working;
        try { await run(button); }
        catch { status.textContent = text.failed; button.disabled = false; }
      });
      return button;
    };
    actions.append(
      actionButton(text.terminal, true, async (button) => {
        await post(endpoints.terminal);
        status.textContent = '';
        button.disabled = false;
      }),
      actionButton(text.diagnostics, false, async (button) => {
        await post(endpoints.diagnostics);
        status.textContent = text.diagnosticsDone;
        button.disabled = false;
      }),
    );
    const confirm = element('div', { hidden: '', dataset: { dshRecoveryConfirm: '' } });
    confirm.append(element('p', { dataset: { dshRecoveryConfirmText: '' } }, text.rollbackConfirm));
    const rollback = actionButton(text.rollback, false, async (button) => {
      confirm.hidden = false;
      status.textContent = '';
      button.disabled = true;
    });
    actions.append(rollback);
    const confirmRollback = element('button', { type: 'button', 'data-primary': '' }, text.confirmRollback);
    const cancelRollback = element('button', { type: 'button' }, text.cancel);
    confirmRollback.addEventListener('click', async () => {
      confirmRollback.disabled = true;
      cancelRollback.disabled = true;
      status.textContent = text.working;
      try {
        await post(endpoints.rollback);
        controls.forEach(control => { control.disabled = true; });
        status.textContent = text.restarting;
      } catch {
        confirmRollback.disabled = false;
        cancelRollback.disabled = false;
        rollback.disabled = false;
        status.textContent = text.rollbackUnavailable;
      }
    });
    cancelRollback.addEventListener('click', () => {
      confirm.hidden = true;
      rollback.disabled = false;
      status.textContent = '';
    });
    confirm.append(confirmRollback, cancelRollback);
    const profile = element('div', { dataset: { dshRecoveryProfile: '' } });
    profile.append(element('p', { dataset: { dshRecoveryLabel: '' } }, text.profile));
    const profileRow = element('div', { dataset: { dshRecoveryProfileRow: '' } });
    const select = element('select', { 'aria-label': text.profile, disabled: '' });
    select.append(element('option', { value: '' }, text.loadingProfiles));
    const switchProfile = element('button', { type: 'button', disabled: '' }, text.switchProfile);
    const createProfile = actionButton(text.createProfile, false, async (button) => {
      await post(endpoints.createProfile);
      status.textContent = text.creatorOpened;
      button.disabled = false;
    });
    switchProfile.addEventListener('click', async () => {
      if (!select.value) return;
      switchProfile.disabled = true;
      select.disabled = true;
      status.textContent = text.working;
      try {
        await post(endpoints.selectProfile, { name: select.value });
        controls.forEach(control => { control.disabled = true; });
        status.textContent = text.restarting;
      } catch {
        switchProfile.disabled = false;
        select.disabled = false;
        status.textContent = text.failed;
      }
    });
    profileRow.append(select, switchProfile, createProfile);
    profile.append(profileRow);
    panel.append(actions, confirm, profile, status);
    report.append(panel);
    fetch(endpoints.settings, { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error('settings unavailable'); return response.json(); })
      .then((value) => {
        if (!value || !Array.isArray(value.profiles) || typeof value.current !== 'string') throw new Error('invalid settings');
        const profiles = value.profiles.filter((candidate) => candidate && candidate.selectable === true
          && typeof candidate.name === 'string' && candidate.name !== value.current);
        select.replaceChildren();
        if (profiles.length === 0) {
          select.append(element('option', { value: '' }, text.noProfiles));
          select.disabled = true;
          switchProfile.disabled = true;
          return;
        }
        for (const candidate of profiles) select.append(element('option', { value: candidate.name }, candidate.name));
        select.disabled = false;
        switchProfile.disabled = false;
      })
      .catch(() => {
        select.replaceChildren(element('option', { value: '' }, text.profilesFailed));
        select.disabled = true;
        switchProfile.disabled = true;
      });
  };
  new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
  attach();
})();`

/** Backwards-compatible names retained for downstream tests and embedders. */
export const DESKTOP_BOOT_TERMINAL_STYLE = DESKTOP_BOOT_RECOVERY_STYLE
export const DESKTOP_BOOT_TERMINAL_SCRIPT = DESKTOP_BOOT_RECOVERY_SCRIPT

/** Structured rows consumed by both the loopback server and static boot renderer. */
export function desktopBootRecoveryInjections(): readonly IndexInjection[] {
  return [
    { kind: 'style', text: DESKTOP_BOOT_RECOVERY_STYLE },
    { kind: 'script', placement: 'body', text: DESKTOP_BOOT_RECOVERY_SCRIPT },
  ]
}
