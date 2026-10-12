import { Settings } from "lucide-react"
import { useState, type ReactNode } from "react"
import { usePreferences } from "@/app/hooks"
import { SettingsDialog } from "./SettingsDialog"

/** The bottom of the sidebar: quiet status and the way into preferences. */
export const SidebarFooter = ({ children }: { children?: ReactNode }) => {
  const preferences = usePreferences()
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <footer className="flex h-9 flex-none items-center gap-2 px-4 text-xs text-subtle-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <button
        aria-label="Preferences"
        onClick={() => setSettingsOpen(true)}
        className="flex size-6 items-center justify-center rounded-md hover:bg-accent/50 hover:text-foreground"
      >
        <Settings className="size-3.5" />
      </button>
      {preferences && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} preferences={preferences} />}
    </footer>
  )
}
