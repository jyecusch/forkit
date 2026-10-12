import { Settings } from "lucide-react"
import { useState, type ReactNode } from "react"
import { usePreferences } from "@/app/hooks"
import { SettingsDialog } from "./SettingsDialog"

/**
 * The bottom of the sidebar: what is running, if anything, and the way into
 * preferences. The gear's icon ends on the sidebar's right guide.
 */
export const SidebarFooter = ({ children }: { children?: ReactNode }) => {
  const preferences = usePreferences()
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <footer className="flex h-10 flex-none items-center gap-2 pr-[11px] pl-4 text-xs text-subtle-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <button
        aria-label="Preferences"
        onClick={() => setSettingsOpen(true)}
        className="flex size-6 items-center justify-center rounded-md hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <Settings className="size-3.5" />
      </button>
      {preferences && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} preferences={preferences} />}
    </footer>
  )
}
