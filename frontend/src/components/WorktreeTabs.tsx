import { Folder } from "lucide-react"
import { baseName, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Ref, Worktree, WorktreeId, WorktreeOperation } from "@/model/model.gen"
import { changeCount } from "@/lib/worktree"

interface WorktreeTabsProps {
  readonly worktrees: ReadonlyArray<Worktree>
  readonly refsById: ReadonlyMap<string, Ref>
  readonly active: WorktreeId | undefined
  readonly onSelect: (worktree: Worktree) => void
}

/** One sub-tab per worktree of the active repository. */
export const WorktreeTabs = ({ worktrees, refsById, active, onSelect }: WorktreeTabsProps) => (
  <div role="tablist" aria-label="Worktrees" className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
    {worktrees.map((worktree) => {
      const on = worktree.id === active
      const changes = changeCount(worktree)
      return (
        <button
          key={worktree.id}
          role="tab"
          aria-selected={on}
          onClick={() => onSelect(worktree)}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5",
            on ? "bg-card text-foreground shadow-[inset_0_-2px_0_var(--primary)]" : "text-secondary-foreground hover:text-foreground",
          )}
        >
          <Folder aria-hidden className="size-3" />
          <span>{headLabel(worktree, refsById)}</span>
          <span className="text-xs text-subtle-foreground">{baseName(worktree.path)}</span>
          {worktree.operation !== "none" && (
            <span className="rounded-lg bg-destructive/15 px-1.5 text-[11px] text-destructive">{operationLabels[worktree.operation]}</span>
          )}
          {changes > 0 && (
            <span className="rounded-lg bg-warning/15 px-1.5 text-[11px] text-warning">
              {changes} {changes === 1 ? "change" : "changes"}
            </span>
          )}
        </button>
      )
    })}
  </div>
)

export const headLabel = (worktree: Worktree, refsById: ReadonlyMap<string, Ref>) => {
  switch (worktree.head.kind) {
    case "branch":
      return refsById.get(worktree.head.refId ?? "")?.shortName ?? worktree.head.refId?.split("refs/heads/")[1] ?? "branch"
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
