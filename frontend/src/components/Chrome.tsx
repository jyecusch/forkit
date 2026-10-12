import type { CSSProperties, ReactNode } from "react"
import { dragRegion, isMac, isWindows } from "@/lib/platform"

interface ChromeProps {
  /** The sidebar column, below the row the window controls sit in. */
  readonly sidebar: ReactNode
  /** The tab strip along the top edge, beside the window controls. */
  readonly tabs: ReactNode
  readonly children: ReactNode
}

/** Gap between the panel and the window's edges. */
const inset = 8
/**
 * The window's corner radius. macOS draws windows with toolbars, which the
 * inset title bar style is, at 26 pt; Windows 11 uses 8 px; a browser
 * viewport is square.
 */
const windowRadius = isMac ? 26 : isWindows ? 8 : 0
/** Concentric with the window's corners across the inset. */
const panelRadius = Math.max(windowRadius - inset, 6)

/**
 * The window's frame: the sidebar and the top strip are one chrome surface,
 * and the content sits on an inset panel. The top strip is 40 pt tall, so on
 * macOS its tabs are centred on the window controls, 24 pt down.
 */
export const Chrome = ({ sidebar, tabs, children }: ChromeProps) => (
  <div className="flex min-h-0 flex-1 bg-sidebar" style={{ "--panel-radius": `${panelRadius}px` } as CSSProperties}>
    <div className="flex w-[clamp(208px,20vw,264px)] flex-none flex-col">
      <div className="h-10 flex-none" style={dragRegion} />
      {sidebar}
    </div>
    <div className="flex min-w-0 flex-1 flex-col" style={{ paddingRight: inset, paddingBottom: inset }}>
      <div className="flex h-10 flex-none items-end pl-[var(--panel-radius)]" style={dragRegion}>
        {tabs}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--panel-radius)] border bg-background">
        {children}
      </div>
    </div>
  </div>
)
