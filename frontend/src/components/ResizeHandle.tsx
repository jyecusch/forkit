import { useRef } from "react"
import type { LayoutSizeControl } from "@/app/layoutSizes"
import { cn } from "@/lib/utils"

interface ResizeHandleProps {
  readonly label: string
  /** "vertical" is a line between columns, dragged sideways; "horizontal" is between rows, dragged up and down. */
  readonly orientation: "vertical" | "horizontal"
  /** Which way the size grows: 1 when dragging right or down grows it, -1 when dragging left or up does. */
  readonly grows: 1 | -1
  /** The size in pixels when a drag starts, as laid out now. */
  readonly measure: () => number
  /** The smallest and largest sizes in pixels, read when a drag starts, since they may depend on what is laid out. */
  readonly limits: () => readonly [min: number, max: number]
  /** Converts between the pixels dragged and the size remembered, such as a fraction of a container. */
  readonly toSize?: (pixels: number) => number
  readonly control: LayoutSizeControl
  readonly className?: string
}

const keyStep = 8
const bigKeyStep = 48

/**
 * A separator that resizes a panel or column by dragging or with the arrow
 * keys. Double-clicking it lets the size be chosen automatically again.
 */
export const ResizeHandle = ({ label, orientation, grows, measure, limits, toSize = (px) => px, control, className }: ResizeHandleProps) => {
  const drag = useRef<{ start: number; from: number; last: number; min: number; max: number }>(undefined)
  const vertical = orientation === "vertical"
  const clamp = (px: number, [min, max]: readonly [number, number]) => Math.round(Math.min(Math.max(px, min), max))

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      tabIndex={0}
      title={`Drag to resize; double-click to reset`}
      className={cn(
        "group/resize z-10 flex touch-none items-center justify-center outline-none select-none",
        vertical ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const from = measure()
        const [min, max] = limits()
        drag.current = { start: vertical ? event.clientX : event.clientY, from, last: from, min, max }
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        const moved = (vertical ? event.clientX : event.clientY) - drag.current.start
        drag.current.last = clamp(drag.current.from + grows * moved, [drag.current.min, drag.current.max])
        control.resize(toSize(drag.current.last))
      }}
      onPointerUp={() => {
        if (drag.current && drag.current.last !== drag.current.from) control.commit(toSize(drag.current.last))
        drag.current = undefined
      }}
      onPointerCancel={() => {
        drag.current = undefined
      }}
      onDoubleClick={control.reset}
      onKeyDown={(event) => {
        const forward = vertical ? "ArrowRight" : "ArrowDown"
        const back = vertical ? "ArrowLeft" : "ArrowUp"
        if (event.key !== forward && event.key !== back) return
        event.preventDefault()
        const step = (event.shiftKey ? bigKeyStep : keyStep) * (event.key === forward ? grows : -grows)
        control.commit(toSize(clamp(measure() + step, limits())))
      }}
    >
      <span
        className={cn(
          "rounded-full bg-ring opacity-0 transition-opacity group-hover/resize:opacity-60 group-focus-visible/resize:opacity-100 group-active/resize:opacity-100",
          vertical ? "h-full w-0.5" : "h-0.5 w-full",
        )}
      />
    </div>
  )
}
