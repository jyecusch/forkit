import { useLiveQuery } from "@tanstack/react-db"
import { Plus, X } from "lucide-react"
import { useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useRun, useSession } from "@/app/hooks"
import { reposCollection, worktreesCollection } from "@/data/collections"
import { noDrag } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { changeCount } from "@/lib/worktree"
import type { Repo, RepoId } from "@/model/model.gen"
import { Commands } from "@/services/Commands"

/**
 * One tab per open repository, in session order. The active tab is the
 * panel's colour and opens into it; the rest sit quietly on the chrome.
 */
export const RepoTabs = () => {
  const run = useRun()
  const session = useSession()
  const { data: repos } = useLiveQuery({ query: (q) => q.from({ repo: reposCollection }) })
  const ordered = useMemo(() => {
    const order = session?.openRepos.map((open) => open.id) ?? []
    return repos.filter((repo) => order.includes(repo.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  }, [repos, session])
  const active = session?.activeRepoId
  const tabRefs = useRef(new Map<RepoId, HTMLDivElement>())

  const select = (repo: RepoId) => void run(Commands.use((commands) => commands.selectRepository(repo)))
  const close = (repo: RepoId) => void run(Commands.use((commands) => commands.closeRepository(repo)))

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

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = ordered[(index + step + ordered.length) % ordered.length]
    if (next) {
      tabRefs.current.get(next.id)?.focus()
      select(next.id)
    }
  }

  return (
    <div role="tablist" aria-label="Repositories" className="flex min-w-0 items-end gap-0.5">
      {ordered.map((repo, index) => {
        const on = repo.id === active
        return (
          <div
            key={repo.id}
            ref={(element) => {
              if (element) tabRefs.current.set(repo.id, element)
              else tabRefs.current.delete(repo.id)
            }}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            draggable
            onDragStart={() => setDragging(repo.id)}
            onDragEnd={() => setDragging(undefined)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => drop(repo.id)}
            onClick={() => select(repo.id)}
            onAuxClick={(event) => event.button === 1 && close(repo.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={noDrag}
            className={cn(
              // Tabs share one width, like a browser's, so labels line up and
              // the close button can sit in the right padding of every tab.
              "group relative flex h-8 w-44 min-w-24 shrink cursor-default items-center gap-2 rounded-t-[10px] border border-b-0 pr-7 pl-3",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              on
                ? "z-10 -mb-px h-[33px] bg-background text-foreground"
                : "border-transparent text-secondary-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            <RepoStatus repo={repo} />
            <span className="min-w-0 flex-1 truncate">{repo.name}</span>
            <button
              aria-label={`Close ${repo.name}`}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation()
                close(repo.id)
              }}
              className={cn(
                "absolute top-1/2 right-2 flex size-4 -translate-y-1/2 items-center justify-center rounded text-subtle-foreground hover:bg-foreground/10 hover:text-foreground",
                on ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <X className="size-2.5" strokeWidth={2.5} />
            </button>
          </div>
        )
      })}
      <button
        aria-label="Open repository"
        title="Open repository"
        onClick={() => void run(Commands.use((commands) => commands.openRepository()))}
        style={noDrag}
        className="mb-1 ml-1 flex size-6 flex-none items-center justify-center rounded-md text-subtle-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Loading, errors, operations in progress and uncommitted changes, each
 * with its own colour; nothing when the repository is clean.
 */
const RepoStatus = ({ repo }: { repo: Repo }) => {
  const { data: worktrees } = useLiveQuery({ query: (q) => q.from({ worktree: worktreesCollection(repo.id) }) })
  const status =
    repo.state === "error"
      ? { color: "bg-destructive", label: repo.error ?? "Could not read this repository" }
      : repo.state === "loading"
        ? { color: "bg-subtle-foreground animate-pulse", label: "Loading" }
        : worktrees.some((wt) => wt.operation !== "none")
          ? { color: "bg-warning animate-pulse", label: "A merge or rebase is in progress" }
          : worktrees.some((wt) => changeCount(wt) > 0)
            ? { color: "bg-primary", label: "Uncommitted changes" }
            : undefined
  if (!status) return null
  return <span role="img" aria-label={status.label} title={status.label} className={cn("size-1.5 flex-none rounded-full", status.color)} />
}
