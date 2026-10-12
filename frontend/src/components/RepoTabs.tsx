import { useLiveQuery } from "@tanstack/react-db"
import { Plus, X } from "lucide-react"
import { useState, type CSSProperties } from "react"
import { worktreesCollection } from "@/data/collections"
import { cn } from "@/lib/utils"
import { changeCount } from "@/lib/worktree"
import type { Repo, RepoId } from "@/model/model.gen"

interface RepoTabsProps {
  readonly repos: ReadonlyArray<Repo>
  readonly active: RepoId | undefined
  readonly onSelect: (repo: RepoId) => void
  readonly onClose: (repo: RepoId) => void
  readonly onOpen: () => void
  readonly onReorder: (order: ReadonlyArray<RepoId>) => void
}

/** Wails treats elements with this style as the window's drag handle. */
const dragRegion = { "--wails-draggable": "drag" } as CSSProperties
const noDrag = { "--wails-draggable": "no-drag" } as CSSProperties

/**
 * On macOS the window controls sit inside this bar, near its top, so the
 * tabs start clear of them.
 */
const isMac = navigator.userAgent.includes("Mac")

/** One tab per open repository, reorderable by dragging. */
export const RepoTabs = ({ repos, active, onSelect, onClose, onOpen, onReorder }: RepoTabsProps) => {
  const [dragging, setDragging] = useState<RepoId>()
  // Dropping on a tab puts the dragged one where that tab was, so dragging
  // right lands after it and dragging left lands before it.
  const drop = (target: RepoId) => {
    if (!dragging || dragging === target) return
    const ids = repos.map((repo) => repo.id)
    const movingRight = ids.indexOf(dragging) < ids.indexOf(target)
    const order = ids.filter((id) => id !== dragging)
    order.splice(order.indexOf(target) + (movingRight ? 1 : 0), 0, dragging)
    onReorder(order)
  }
  return (
    <div
      role="tablist"
      aria-label="Repositories"
      className={cn("flex h-[36px] flex-none items-end gap-0.5 border-b bg-sidebar pr-3", isMac ? "pl-[84px]" : "pl-2")}
      style={dragRegion}
    >
      {repos.map((repo) => {
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
            onClick={() => onSelect(repo.id)}
            onKeyDown={(event) => event.key === "Enter" && onSelect(repo.id)}
            style={noDrag}
            className={cn(
              // The active tab opens into the content below: it covers the
              // bar's bottom border with the content's background.
              "group -mb-px flex h-[30px] cursor-default items-center gap-2 rounded-t-lg border border-transparent pr-1 pl-3",
              on
                ? "border-border border-b-background bg-background font-medium text-foreground"
                : "text-secondary-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            <RepoIndicator repo={repo} />
            {repo.name}
            <button
              aria-label={`Close ${repo.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(repo.id)
              }}
              className="rounded p-0.5 text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      <button
        aria-label="Open repository"
        onClick={onOpen}
        style={noDrag}
        className="mb-1 flex size-[22px] items-center justify-center rounded-md text-secondary-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

/** A dot that shows loading, errors, operations in progress or uncommitted changes. */
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
            : ["bg-transparent", ""]
  return <span title={label} className={cn("size-[7px] rounded-full", color)} />
}
