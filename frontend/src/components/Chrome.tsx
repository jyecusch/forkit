import { createContext, use, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { dragRegion, isMac, isWindows } from "@/lib/platform"
import { cn } from "@/lib/utils"

interface ChromeProps {
  /** The tab strip along the top edge, beside the window controls. */
  readonly tabs: ReactNode
  /** Sidebar content shown directly, for views without layers. */
  readonly sidebar?: ReactNode
  /** Panel content, and any ChromeLayers. */
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

/** Where ChromeLayers render their sidebar and panel content. */
const Hosts = createContext<{ readonly sidebar: HTMLElement | null; readonly panel: HTMLElement | null }>({
  sidebar: null,
  panel: null,
})

/**
 * The window's frame: the sidebar and the top strip are one chrome surface,
 * and the content sits on an inset panel. The top strip is 40 pt tall, so on
 * macOS its tabs are centred on the window controls, 24 pt down. The tab
 * strip comes first in the document, so keyboard focus starts at the top.
 */
export const Chrome = ({ tabs, sidebar, children }: ChromeProps) => {
  const [sidebarHost, setSidebarHost] = useState<HTMLElement | null>(null)
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null)
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-[clamp(208px,20vw,264px)_minmax(0,1fr)] grid-rows-[40px_minmax(0,1fr)] bg-sidebar"
      style={{ "--panel-radius": `${panelRadius}px` } as CSSProperties}
    >
      <div className="col-start-1 row-start-1" style={dragRegion} />
      <div className="col-start-2 row-start-1 flex items-end pl-[calc(var(--panel-radius)+18px)]" style={{ ...dragRegion, paddingRight: inset }}>
        {tabs}
      </div>
      <div className="relative col-start-1 row-start-2 flex min-h-0 flex-col">
        {sidebar}
        <div ref={setSidebarHost} className="contents" />
      </div>
      <div className="col-start-2 row-start-2 flex min-h-0 min-w-0 flex-col" style={{ paddingRight: inset, paddingBottom: inset }}>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--panel-radius)] border bg-background">
          <Hosts value={{ sidebar: sidebarHost, panel: panelHost }}>{children}</Hosts>
          <div ref={setPanelHost} className="contents" />
        </div>
      </div>
    </div>
  )
}

interface ChromeLayerProps {
  /** Shown and interactive; inactive layers keep their state out of sight. */
  readonly active: boolean
  readonly sidebar: ReactNode
  readonly children: ReactNode
}

/**
 * One view's sidebar and panel content, laid over the frame's. Inactive
 * layers are invisible and inert, and an activated layer gets back the
 * focus it had, so switching between views is like switching windows.
 */
export const ChromeLayer = ({ active, sidebar, children }: ChromeLayerProps) => {
  const hosts = use(Hosts)
  const panelRef = useRef<HTMLDivElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const remember = (event: React.FocusEvent) => {
    lastFocused.current = event.target as HTMLElement
  }
  useEffect(() => {
    if (!active || document.activeElement !== document.body) return
    const target = lastFocused.current?.isConnected ? lastFocused.current : panelRef.current?.querySelector<HTMLElement>("[role=grid]")
    target?.focus({ preventScroll: true })
  }, [active])

  const layer = (content: ReactNode, ref?: React.Ref<HTMLDivElement>) => (
    <div
      ref={ref}
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
      inert={!active}
      onFocus={remember}
    >
      {content}
    </div>
  )
  return (
    <>
      {hosts.sidebar && createPortal(layer(sidebar), hosts.sidebar)}
      {hosts.panel && createPortal(layer(children, panelRef), hosts.panel)}
    </>
  )
}
