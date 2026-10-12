import { Settings } from "lucide-react"
import type { ReactNode } from "react"

/** The strip along the bottom of the window. */
export const StatusBar = ({ children, onOpenSettings }: { children: ReactNode; onOpenSettings: () => void }) => (
  <footer className="flex flex-wrap items-center gap-4 border-t bg-sidebar px-3 py-1 text-xs text-secondary-foreground">
    {children}
    <div className="flex-1" />
    <button aria-label="Preferences" onClick={onOpenSettings} className="rounded p-0.5 hover:bg-accent hover:text-foreground">
      <Settings className="size-3.5" />
    </button>
  </footer>
)
