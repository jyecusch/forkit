import { useLiveQuery } from "@tanstack/react-db"
import { Plus, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useRun, useSession } from "@/app/hooks"
import { reposCollection, worktreesCollection } from "@/data/collections"
import { noDrag } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { changeCount } from "@/lib/worktree"
import type { Repo, RepoId } from "@/model/model.gen"
import { Commands } from "@/services/Commands"

/**
 * One tab per open repository, in session order. The active tab is the
 * panel's colour and flows into it; the rest sit quietly on the chrome.
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
  // Keyboard focus in the strip follows the active tab, however it changed.
  useEffect(() => {
    if (!active || !(document.activeElement instanceof HTMLElement)) return
    if (document.activeElement.getAttribute("role") === "tab") tabRefs.current.get(active)?.focus()
  }, [active])

  const select = (repo: RepoId) => void run(Commands.use((commands) => commands.selectRepository(repo)))
  const close = (repo: RepoId) => void run(Commands.use((commands) => commands.closeRepository(repo)))

  const [dragging, setDragging] = useState<RepoId>()
  const [dropTarget, setDropTarget] = useState<RepoId>()
  const ids = ordered.map((repo) => repo.id)
  // Dropping on a tab puts the dragged one where that tab was, so dragging
  // right lands after it and dragging left lands before it.
  const landsAfter = (target: RepoId) => dragging !== undefined && ids.indexOf(dragging) < ids.indexOf(target)
  const drop = (target: RepoId) => {
    if (!dragging || dragging === target) return
    const order = ids.filter((id) => id !== dragging)
    order.splice(order.indexOf(target) + (landsAfter(target) ? 1 : 0), 0, dragging)
    void run(Commands.use((commands) => commands.reorderRepositories(order)))
  }
  const endDrag = () => {
    setDragging(undefined)
    setDropTarget(undefined)
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
    <div role="tablist" aria-label="Repositories" className="flex min-w-0 items-end">
      {ordered.map((repo, index) => {
        const on = repo.id === active
        // Inactive neighbours are separated by a short rule.
        const divided = index > 0 && !on && ordered[index - 1]!.id !== active
        const showDrop = dropTarget === repo.id && dragging !== undefined && dragging !== repo.id
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
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move"
              setDragging(repo.id)
            }}
            onDragEnd={endDrag}
            onDragOver={(event) => {
              event.preventDefault()
              setDropTarget(repo.id)
            }}
            onDrop={() => {
              drop(repo.id)
              endDrag()
            }}
            onClick={(event) => {
              // A click hands focus on to the repository, as macOS tab bars
              // do; only the keyboard keeps focus in the strip.
              if (event.detail > 0) event.currentTarget.blur()
              select(repo.id)
            }}
            onAuxClick={(event) => event.button === 1 && close(repo.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={noDrag}
            className={cn(
              // Tabs share one width, like a browser's, so labels line up and
              // the close button and status sit in the right padding of every tab.
              "group relative flex h-8 w-44 min-w-12 shrink cursor-default items-center rounded-t-[10px] border border-b-0 pr-8 pl-3",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              on
                ? "z-10 -mb-px h-[33px] bg-background text-foreground"
                : "isolate border-transparent text-secondary-foreground hover:text-foreground",
              dragging === repo.id && "opacity-50",
            )}
          >
            {on ? (
              <>
                <Flare side="left" />
                <Flare side="right" />
              </>
            ) : (
              <span aria-hidden className="absolute inset-x-1 inset-y-1 -z-10 rounded-md group-hover:bg-foreground/[0.05]" />
            )}
            {divided && <span aria-hidden className="absolute top-1/2 -left-px h-4 w-px -translate-y-1/2 bg-border" />}
            {showDrop && (
              <span
                aria-hidden
                className={cn("absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary", landsAfter(repo.id) ? "-right-px" : "-left-px")}
              />
            )}
            <span className="min-w-0 flex-1 truncate">{repo.name}</span>
            <span className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center">
              <RepoStatus repo={repo} />
              <button
                aria-label={`Close ${repo.name}`}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation()
                  close(repo.id)
                }}
                className="absolute inset-0 flex items-center justify-center rounded text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
        )
      })}
      <button
        aria-label="Open repository"
        title="Open repository"
        onClick={() => void run(Commands.use((commands) => commands.openRepository()))}
        style={noDrag}
        className="mb-1 ml-3 flex size-6 flex-none items-center justify-center rounded-md text-subtle-foreground hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}

/** Size of the concave corners joining the active tab to the panel. */
const flare = 10

/**
 * A concave corner at the foot of the active tab, so the tab flows into the
 * panel's top edge instead of sitting on it.
 */
const Flare = ({ side }: { side: "left" | "right" }) => (
  <span
    aria-hidden
    className="pointer-events-none absolute bottom-0"
    style={{
      [side]: -flare - 1,
      width: flare,
      height: flare,
      background: `radial-gradient(circle at ${side === "left" ? "0" : "100%"} 0, transparent ${flare - 1}px, var(--border) ${flare - 1}px ${flare}px, var(--background) ${flare}px)`,
    }}
  />
)

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
  return (
    <span
      role="img"
      aria-label={status.label}
      title={status.label}
      className={cn("size-1.5 rounded-full group-hover:invisible", status.color)}
    />
  )
}
