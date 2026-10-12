import { useLiveQuery } from "@tanstack/react-db"
import { Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useRun, useSession } from "@/app/hooks"
import { reposCollection, worktreesCollection } from "@/data/collections"
import { noDrag } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { changeCount } from "@/lib/worktree"
import type { Repo, RepoId } from "@/model/model.gen"
import { Commands } from "@/services/Commands"

/** One tab per open repository, in session order, reorderable by dragging. */
export const RepoTabs = () => {
  const run = useRun()
  const session = useSession()
  const { data: repos } = useLiveQuery({ query: (q) => q.from({ repo: reposCollection }) })
  const ordered = useMemo(() => {
    const order = session?.openRepos.map((open) => open.id) ?? []
    return repos.filter((repo) => order.includes(repo.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  }, [repos, session])
  const active = session?.activeRepoId

  const [dragging, setDragging] = useState<RepoId>()
  // Dropping on a tab puts the dragged one where that tab was, so dragging
  // right lands after it and dragging left lands before it.
  const drop = (target: RepoId) => {
    if (!dragging || dragging === target) return
    const ids = ordered.map((repo) => repo.id)
    const movingRight = ids.indexOf(dragging) < ids.indexOf(target)
    const order = ids.filter((id) => id !== dragging)
    order.splice(order.indexOf(target) + (movingRight ? 1 : 0), 0, dragging)
    void run(Commands.use((commands) => commands.reorderRepositories(order)))
  }

  return (
    <div role="tablist" aria-label="Repositories" className="flex min-w-0 items-center gap-0.5">
      {ordered.map((repo) => {
        const on = repo.id === active
        return (
          <div
            key={repo.id}
            role="tab"
            aria-selected={on}
            tabIndex={0}
            draggable
            onDragStart={() => setDragging(repo.id)}
            onDragEnd={() => setDragging(undefined)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => drop(repo.id)}
            onClick={() => void run(Commands.use((commands) => commands.selectRepository(repo.id)))}
            onKeyDown={(event) => event.key === "Enter" && void run(Commands.use((commands) => commands.selectRepository(repo.id)))}
            style={noDrag}
            className={cn(
              "group flex h-6 min-w-0 cursor-default items-center gap-1.5 rounded-md pr-0.5 pl-2",
              on ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <RepoIndicator repo={repo} />
            <span className="truncate">{repo.name}</span>
            <button
              aria-label={`Close ${repo.name}`}
              onClick={(event) => {
                event.stopPropagation()
                void run(Commands.use((commands) => commands.closeRepository(repo.id)))
              }}
              className="flex size-5 items-center justify-center rounded text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      <button
        aria-label="Open repository"
        onClick={() => void run(Commands.use((commands) => commands.openRepository()))}
        style={noDrag}
        className="flex size-6 flex-none items-center justify-center rounded-md text-secondary-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

/** A dot for loading, errors, operations in progress or uncommitted changes; nothing when clean. */
const RepoIndicator = ({ repo }: { repo: Repo }) => {
  const { data: worktrees } = useLiveQuery({ query: (q) => q.from({ worktree: worktreesCollection(repo.id) }) })
  const busy = worktrees.some((wt) => wt.operation !== "none")
  const dirty = worktrees.some((wt) => changeCount(wt) > 0)
  const [color, label] =
    repo.state === "error"
      ? ["bg-destructive", repo.error ?? "Error"]
      : repo.state === "loading"
        ? ["bg-subtle-foreground animate-pulse", "Loading"]
        : busy
          ? ["bg-destructive", "Operation in progress"]
          : dirty
            ? ["bg-warning", "Uncommitted changes"]
            : ["", ""]
  if (!color) return null
  return <span title={label} className={cn("size-1.5 flex-none rounded-full", color)} />
}
