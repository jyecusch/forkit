import { Folder, Plus } from "lucide-react"
import type { ReactNode } from "react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { baseName, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Ref, Worktree, WorktreeId, WorktreeOperation } from "@/model/model.gen"
import { changeCount } from "@/lib/worktree"

interface WorktreeTabsProps {
  readonly worktrees: ReadonlyArray<Worktree>
  readonly refsById: ReadonlyMap<string, Ref>
  readonly active: WorktreeId | undefined
  readonly onSelect: (worktree: Worktree) => void
  readonly onCreate: () => void
  readonly onRemove: (worktree: Worktree) => void
  /** Shown at the end of the row, for what applies to the whole view. */
  readonly trailing?: ReactNode
}

/** The view header: one tab per worktree of the active repository. */
export const WorktreeTabs = ({ worktrees, refsById, active, onSelect, onCreate, onRemove, trailing }: WorktreeTabsProps) => (
  <div className="flex h-10 flex-none items-center gap-2 border-b px-2">
    <div role="tablist" aria-label="Worktrees" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
    {worktrees.map((worktree) => {
      const on = worktree.id === active
      const changes = changeCount(worktree)
      const tab = (
        <button
          key={worktree.id}
          role="tab"
          aria-selected={on}
          onClick={() => onSelect(worktree)}
          className={cn(
            "flex h-6 flex-none items-center gap-1.5 rounded-md px-2 whitespace-nowrap",
            on ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Folder aria-hidden className="size-3.5 text-subtle-foreground" />
          <span>{headLabel(worktree, refsById)}</span>
          <span className="text-xs text-subtle-foreground">{baseName(worktree.path)}</span>
          {worktree.operation !== "none" && <span className="text-xs text-destructive">{operationLabels[worktree.operation]}</span>}
          {changes > 0 && (
            <span className="text-xs text-warning">
              {changes} {changes === 1 ? "change" : "changes"}
            </span>
          )}
        </button>
      )
      if (worktree.isMain) {
        return tab
      }
      return (
        <ContextMenu key={worktree.id}>
          <ContextMenuTrigger asChild>{tab}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem variant="destructive" onSelect={() => onRemove(worktree)}>
              Remove worktree…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    })}
      <button
        aria-label="New worktree"
        onClick={onCreate}
        className="flex h-6 flex-none items-center gap-1 rounded-md px-2 text-subtle-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Plus aria-hidden className="size-3.5" />
        Worktree
      </button>
    </div>
    {trailing}
  </div>
)

export const headLabel = (worktree: Worktree, refsById: ReadonlyMap<string, Ref>) => {
  switch (worktree.head.kind) {
    case "branch":
      return refsById.get(worktree.head.refId ?? "")?.shortName ?? "branch"
    case "unborn":
      return "no commits yet"
    case "detached":
      return `detached at ${shortOid(worktree.head.oid)}`
  }
}

const operationLabels: Record<WorktreeOperation, string> = {
  none: "",
  merge: "merging",
  rebase: "rebasing",
  cherryPick: "cherry-picking",
  revert: "reverting",
  bisect: "bisecting",
}
