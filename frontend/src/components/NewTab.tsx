import { Option } from "effect"
import { FolderOpen, FolderPlus, type LucideIcon } from "lucide-react"
import { useRun } from "@/app/hooks"
import { notify } from "@/app/notifications"
import { Commands } from "@/services/Commands"
import { ChromeLayer } from "./Chrome"
import { SidebarFooter } from "./SidebarFooter"

/** The ways to start on a repository, shown in a new tab and when none is open. */
export const NewTab = ({ active }: { active: boolean }) => {
  const run = useRun()
  const open = () => void run(Commands.use((commands) => commands.openRepository()))
  const init = async () => {
    const result = Option.flatten(await run(Commands.use((commands) => commands.initRepository())))
    if (Option.isSome(result) && !result.value.created) {
      notify({ tone: "info", message: `${result.value.repo.name} is already a repository, so it was opened.`, duration: 4000 })
    }
  }

  return (
    <ChromeLayer
      active={active}
      sidebar={
        <>
          <div className="flex-1" />
          <SidebarFooter />
        </>
      }
    >
      <div className="flex flex-1 flex-col items-center justify-center pb-[8vh]">
        <ul className="flex w-80 flex-col gap-1">
          <Action icon={FolderOpen} label="Open repository…" detail="A repository on this computer" shortcut="⌘O" onSelect={open} />
          <Action icon={FolderPlus} label="Create repository…" detail="Start tracking a folder with git" onSelect={() => void init()} />
        </ul>
      </div>
    </ChromeLayer>
  )
}

interface ActionProps {
  readonly icon: LucideIcon
  readonly label: string
  readonly detail: string
  readonly shortcut?: string
  readonly onSelect: () => void
}

const Action = ({ icon: Icon, label, detail, shortcut, onSelect }: ActionProps) => (
  <li>
    <button
      onClick={onSelect}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex size-8 flex-none items-center justify-center rounded-md bg-foreground/[0.06] text-secondary-foreground group-hover:text-foreground">
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground">{label}</span>
        <span className="truncate text-xs text-secondary-foreground">{detail}</span>
      </span>
      {shortcut && <span className="text-xs text-subtle-foreground">{shortcut}</span>}
    </button>
  </li>
)
