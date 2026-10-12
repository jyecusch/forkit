import { FolderGit2 } from "lucide-react"
import { useRun } from "@/app/hooks"
import { Button } from "@/components/ui/button"
import { Commands } from "@/services/Commands"
import { Chrome } from "./Chrome"
import { RepoTabs } from "./RepoTabs"
import { SidebarFooter } from "./SidebarFooter"

/** Shown when no repository is open. */
export const Welcome = () => {
  const run = useRun()
  return (
    <Chrome
      sidebar={
        <>
          <div className="flex-1" />
          <SidebarFooter />
        </>
      }
      header={<RepoTabs />}
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-secondary-foreground">
        <FolderGit2 aria-hidden className="size-10 text-subtle-foreground" />
        <p>Open a repository to see its history and worktrees.</p>
        <Button onClick={() => void run(Commands.use((commands) => commands.openRepository()))}>Open repository…</Button>
      </div>
    </Chrome>
  )
}
