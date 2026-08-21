import type { LabelHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>): JSX.Element {
  return <label className={cn('text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50', className)} data-slot="label" {...props} />
}
export { Label }
