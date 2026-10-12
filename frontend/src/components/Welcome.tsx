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
      tabs={<RepoTabs />}
    >
      <div className="flex flex-1 flex-col items-center justify-center pb-[8vh]">
        <FolderGit2 aria-hidden className="size-8 text-subtle-foreground" />
        <h1 className="mt-4 text-[15px] font-medium">No repository open</h1>
        <p className="mt-1 text-secondary-foreground">Open one to see its history and worktrees.</p>
        <Button className="mt-5" onClick={() => void run(Commands.use((commands) => commands.openRepository()))}>
          Open repository…
        </Button>
      </div>
    </Chrome>
  )
}
