import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm', {
  variants: { variant: { default: 'bg-card text-card-foreground', destructive: 'border-destructive/50 text-destructive' } },
  defaultVariants: { variant: 'default' },
})
function Alert({ className, variant, ...props }: HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>): JSX.Element {
  return <div className={cn(alertVariants({ variant }), className)} data-slot="alert" role="alert" {...props} />
}
function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h5 className={cn('mb-1 font-medium leading-none tracking-tight', className)} data-slot="alert-title" {...props} />
}
function AlertDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('text-sm [&_p]:leading-relaxed', className)} data-slot="alert-description" {...props} />
}
export { Alert, AlertDescription, AlertTitle }
