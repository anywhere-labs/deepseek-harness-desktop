import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { cn } from '../../lib/utils.ts'

function ScrollArea({ className, children, ...props }: ScrollAreaPrimitive.Root.Props): JSX.Element {
  return <ScrollAreaPrimitive.Root className={cn('relative', className)} data-slot="scroll-area" {...props}>
    <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:ring-3 focus-visible:ring-ring/50" data-slot="scroll-area-viewport">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
}

function ScrollBar({ className, orientation = 'vertical', ...props }: ScrollAreaPrimitive.Scrollbar.Props): JSX.Element {
  return <ScrollAreaPrimitive.Scrollbar
    className={cn('flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-vertical:h-full data-vertical:w-2.5', className)}
    data-orientation={orientation}
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    {...props}
  >
    <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" data-slot="scroll-area-thumb" />
  </ScrollAreaPrimitive.Scrollbar>
}

export { ScrollArea, ScrollBar }
