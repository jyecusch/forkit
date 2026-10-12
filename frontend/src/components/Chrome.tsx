import type { ReactNode } from "react"
import { dragRegion, isMac } from "@/lib/platform"
import { cn } from "@/lib/utils"

interface ChromeProps {
  /** Below the window controls in the sidebar column. */
  readonly sidebar: ReactNode
  /** The first header row of the panel, level with the window controls. */
  readonly header: ReactNode
  readonly children: ReactNode
}

/**
 * The window's frame: a sidebar and a thin top edge in one chrome surface,
 * with the content on an inset panel.
 *
 * On macOS the window controls sit at the top of the sidebar column, centred
 * 24 pt down (the inset title bar style). The panel's header row is 32 pt
 * tall and starts 8 pt down, so its contents share the controls' centre line.
 * Elsewhere the sidebar starts 8 pt down too, so its first row lines up with
 * the panel header.
 */
export const Chrome = ({ sidebar, header, children }: ChromeProps) => (
  <div className="flex min-h-0 flex-1 bg-sidebar">
    <div className={cn("flex w-[clamp(200px,20vw,260px)] flex-none flex-col", !isMac && "pt-2")}>
      {isMac && <div className="h-12 flex-none" style={dragRegion} />}
      {sidebar}
    </div>
    <div className="mt-[7px] mr-2 mb-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
      <div className="flex h-8 flex-none items-center gap-1 px-2" style={isMac ? dragRegion : undefined}>
        {header}
      </div>
      {children}
    </div>
  </div>
)
