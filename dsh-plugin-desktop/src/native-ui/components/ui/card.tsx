import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)} data-slot="card" {...props} />
}
function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex flex-col space-y-1.5 p-6', className)} data-slot="card-header" {...props} />
}
function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h2 className={cn('text-lg leading-none font-semibold tracking-tight', className)} data-slot="card-title" {...props} />
}
function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cn('text-sm text-muted-foreground', className)} data-slot="card-description" {...props} />
}
function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('p-6 pt-0', className)} data-slot="card-content" {...props} />
}
function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex items-center p-6 pt-0', className)} data-slot="card-footer" {...props} />
}
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle }
