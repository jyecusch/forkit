import { useEffect } from "react"
import type { RepoId } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import { useRun } from "./hooks"
import { setPreferencesOpen } from "./preferencesDialog"

/**
 * Window-wide shortcuts: ⌘, preferences, ⌘O open, ⌘W close, ⌘1–9 and
 * ⌘⇧[ ⌘⇧] to move between repositories.
 */
export const useShortcuts = (openRepos: ReadonlyArray<RepoId>, active: RepoId | undefined) => {
  const run = useRun()
  useEffect(() => {
    const select = (repo: RepoId | undefined) => repo && void run(Commands.use((commands) => commands.selectRepository(repo)))
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const index = active ? openRepos.indexOf(active) : -1
      const step = (by: number) => openRepos[(index + by + openRepos.length) % openRepos.length]
      const action =
        event.key === ","
          ? () => setPreferencesOpen(true)
          : event.key === "o"
            ? () => void run(Commands.use((commands) => commands.openRepository()))
            : event.key === "w" && active
              ? () => void run(Commands.use((commands) => commands.closeRepository(active)))
              : /^[1-9]$/.test(event.key) && !event.shiftKey
                ? () => select(event.key === "9" ? openRepos[openRepos.length - 1] : openRepos[Number(event.key) - 1])
                : event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")
                  ? () => select(step(event.code === "BracketLeft" ? -1 : 1))
                  : undefined
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [run, openRepos, active])
}
