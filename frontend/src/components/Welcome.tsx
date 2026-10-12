import { FolderGit2 } from "lucide-react"
import { useRun } from "@/app/hooks"
import { Button } from "@/components/ui/button"
import { Commands } from "@/services/Commands"

/** Shown when no repository is open. */
export const Welcome = () => {
  const run = useRun()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-secondary-foreground">
      <FolderGit2 aria-hidden className="size-10 text-subtle-foreground" />
      <p>Open a repository to see its history and worktrees.</p>
      <Button onClick={() => void run(Commands.use((commands) => commands.openRepository()))}>Open repository…</Button>
    </div>
  )
}
