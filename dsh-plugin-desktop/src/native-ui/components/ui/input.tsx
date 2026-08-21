import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

function Input({ className, type = 'text', ...props }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input className={cn('flex h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50', className)} data-slot="input" type={type} {...props} />
}
export { Input }
