import { Folder, GitBranch, X } from "lucide-react"
import { baseName } from "@/lib/format"
import { changeCount, headLabel } from "@/lib/worktree"
import type { GraphView, Ref, Worktree, WorktreeOperation } from "@/model/model.gen"

interface ViewHeaderProps {
  readonly worktree: Worktree | undefined
  readonly refsById: ReadonlyMap<string, Ref>
  /** Set when a ref other than the checked-out branch is emphasized. */
  readonly emphasizedOther: Ref | undefined
  readonly onClearEmphasis: () => void
  readonly view: GraphView | undefined
}

/**
 * The panel's second header level: which worktree and branch the view is
 * about, and what the graph is showing.
 */
export const ViewHeader = ({ worktree, refsById, emphasizedOther, onClearEmphasis, view }: ViewHeaderProps) => {
  const changes = worktree ? changeCount(worktree) : 0
  return (
    <div className="flex h-10 flex-none items-center gap-3 border-b px-3 text-[13px]">
      {worktree && (
        <div className="flex min-w-0 items-center gap-2">
          {!worktree.isMain && (
            <>
              <Folder aria-hidden className="size-4 flex-none text-subtle-foreground" />
              <span className="truncate font-medium text-foreground" title={worktree.path}>
                {baseName(worktree.path)}
              </span>
            </>
          )}
          <span className="flex min-w-0 items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-xs text-secondary-foreground">
            <GitBranch aria-hidden className="size-3 flex-none" />
            <span className="truncate">{headLabel(worktree, refsById)}</span>
          </span>
          {worktree.operation !== "none" && <span className="flex-none text-xs text-warning">{operationLabels[worktree.operation]}</span>}
          {changes > 0 && (
            <span className="flex-none text-xs text-subtle-foreground tabular-nums">
              {changes} uncommitted {changes === 1 ? "change" : "changes"}
            </span>
          )}
        </div>
      )}
      <div className="ml-auto flex flex-none items-center gap-3 text-xs text-subtle-foreground">
        {emphasizedOther && (
          <span className="flex h-6 items-center gap-1.5 rounded-md bg-primary/15 pr-1 pl-2 text-primary" title="Its history is drawn at full strength; the rest is toned down">
            <span className="max-w-48 truncate">{emphasizedOther.shortName}</span>
            <button
              aria-label="Stop emphasizing"
              onClick={onClearEmphasis}
              className="flex size-4 items-center justify-center rounded hover:bg-primary/20"
            >
              <X className="size-3" />
            </button>
          </span>
        )}
        {view && (
          <span className="tabular-nums">
            {view.totalRows.toLocaleString()} {view.totalRows === 1 ? "commit" : "commits"}
            {view.complete ? "" : "…"}
          </span>
        )}
      </div>
    </div>
  )
}

const operationLabels: Record<WorktreeOperation, string> = {
  none: "",
  merge: "Merging",
  rebase: "Rebasing",
  cherryPick: "Cherry-picking",
  revert: "Reverting",
  bisect: "Bisecting",
}
