import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'

const SCHEME = 'dsh-profile-create:'

interface Copy {
  readonly title: string
  readonly heading: string
  readonly description: string
  readonly label: string
  readonly placeholder: string
  readonly start: string
  readonly cancel: string
  readonly empty: string
}

const COPY: Record<'en' | 'zh', Copy> = {
  en: {
    title: 'Add Profile',
    heading: 'Create and start a Profile',
    description: 'Create a web-capable Profile and select it for the next Desktop start.',
    label: 'Profile name',
    placeholder: 'For example: work',
    start: 'Create and Start',
    cancel: 'Cancel',
    empty: 'Enter a Profile name.',
  },
  zh: {
    title: '添加配置',
    heading: '创建并启动配置',
    description: '创建一个可用于桌面界面的配置，并在下一次启动时使用。',
    label: '配置名称',
    placeholder: '例如：work',
    start: '创建并启动',
    cancel: '取消',
    empty: '请输入配置名称。',
  },
}

function locale(): 'en' | 'zh' {
  return new URLSearchParams(window.location.search).get('locale') === 'zh' ? 'zh' : 'en'
}

function submit(name: string): void {
  const url = new URL(`${SCHEME}//submit`)
  url.searchParams.set('name', name)
  window.location.assign(url.href)
}

export function ProfileCreateApp(): JSX.Element {
  const copy = COPY[locale()]
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const reportError = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return
      setError(event.detail)
      document.getElementById('profile-name')?.focus()
    }
    window.addEventListener('dsh-profile-create-error', reportError)
    return () => { window.removeEventListener('dsh-profile-create-error', reportError) }
  }, [])
  const onSubmit = (): void => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError(copy.empty)
      return
    }
    submit(trimmed)
  }
  return <main className="min-h-screen overflow-hidden p-6"><section className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-md flex-col">
    <header className="mb-5"><h1 className="text-lg leading-none font-semibold tracking-tight">{copy.heading}</h1><p className="mt-2 text-sm text-muted-foreground">{copy.description}</p></header>
    <div className="space-y-2">
      <Label htmlFor="profile-name">{copy.label}</Label>
      <Input autoFocus id="profile-name" maxLength={255} onChange={event => { setName(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter') onSubmit() }} placeholder={copy.placeholder} value={name} />
      {error.length > 0 ? <Alert aria-live="polite" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </div>
    <footer className="mt-auto flex justify-end gap-2 pt-5">
      <Button onClick={() => { window.location.assign(`${SCHEME}//cancel`) }} type="button" variant="outline"><X />{copy.cancel}</Button>
      <Button onClick={onSubmit} type="button"><Plus />{copy.start}</Button>
    </footer>
  </section></main>
}
