import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { vi } from 'vitest'

function Icon(): ReactNode {
  return <span aria-hidden="true" />
}

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  defineStore: <T, A extends Record<string, (draft: T, ...params: never[]) => void>>(decl: {
    init: () => T
    actions: A
  }) => ({
    spec: decl,
    create: () => {
      let state = decl.init()
      const listeners = new Set<() => void>()
      const actions = Object.fromEntries(Object.entries(decl.actions).map(([key, mutate]) => [key, (...params: never[]) => {
        mutate(state, ...params)
        for (const listener of listeners) listener()
      }]))
      return {
        actions,
        getSnapshot: () => state,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      }
    },
  }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, icon, size: _size, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: ReactNode
    size?: string
    variant?: string
  }) => <button {...props}>{icon}{children}</button>,
  Input: ({ icon: _icon, ...props }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) => <input {...props} />,
  Pill: ({ active: _active, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) => (
    props.onClick === undefined ? <span>{children}</span> : <button {...props}>{children}</button>
  ),
  StateDot: ({ state }: { state: string }) => <span data-state={state} />,
  Modal: ({ children, className, closeLabel: _closeLabel, contentClassName, description, footer, open, title }: {
    children?: ReactNode
    className?: string
    closeLabel?: string
    contentClassName?: string
    description?: ReactNode
    footer?: ReactNode
    open: boolean
    title: ReactNode
  }) => open ? (
    <div role="dialog" className={className} aria-label={typeof title === 'string' ? title : undefined}>
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
      <div className={contentClassName}>{children}</div>
      {footer}
    </div>
  ) : null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  IconCheckOutline16: Icon,
  IconChevronDownOutline14: Icon,
  IconChevronUpOutline14: Icon,
  IconCloseOutline16: Icon,
  IconCordisPluginOutline14: Icon,
  IconDataOutline16: Icon,
  IconDownloadOutline16: Icon,
  IconGlobeOutline14: Icon,
  IconPlusOutline16: Icon,
  IconPauseOutline16: Icon,
  IconPlayOutline16: Icon,
  IconRefreshOutline16: Icon,
  IconRightUpOutline16: Icon,
  IconSearchOutline16: Icon,
  IconSettingsOutline16: Icon,
  IconTrashOutline16: Icon,
  IconWarningOutline16: Icon,
}))
