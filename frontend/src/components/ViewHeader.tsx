import { GitBranch, GitCommitHorizontal, LoaderCircle, PanelRight, Tag, X } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { baseName } from "@/lib/format"
import { changeCount, headLabel } from "@/lib/worktree"
import type { GraphView, Ref, Worktree, WorktreeOperation } from "@/model/model.gen"
import { AheadBehind } from "./AheadBehind"
import { emphasizedTint, laneColor } from "./RefBadge"
import { WorktreeIcon } from "./WorktreeIcon"

interface ViewHeaderProps {
  readonly worktree: Worktree | undefined
  readonly refsById: ReadonlyMap<string, Ref>
  /** Whether the checked-out branch is the emphasized ref. */
  readonly headEmphasized: boolean
  /** Set when a ref other than the checked-out branch is emphasized. */
  readonly emphasizedOther: Ref | undefined
  readonly onClearEmphasis: () => void
  readonly view: GraphView | undefined
  /** A checkout is running, so the branch is about to change. */
  readonly checkingOut: boolean
  /** Selects the uncommitted changes, from the count of them. */
  readonly onShowChanges: () => void
  readonly detailsShown: boolean
  readonly onToggleDetails: () => void
  /** Actions on the checked-out branch, shown at the end of the header. */
  readonly actions?: ReactNode
}

/**
 * The panel's second header level: which worktree and branch the view is
 * about, and what the graph is showing.
 */
export const ViewHeader = ({ worktree, refsById, headEmphasized, emphasizedOther, onClearEmphasis, view, checkingOut, detailsShown, onToggleDetails, onShowChanges, actions }: ViewHeaderProps) => {
  const changes = worktree ? changeCount(worktree) : 0
  const head = worktree?.head.refId ? refsById.get(worktree.head.refId) : undefined
  // A branch's chip takes its graph line's colour; anything else the accent.
  const emphasizedId = headEmphasized ? head?.id : emphasizedOther?.id
  const thread = emphasizedId === undefined ? undefined : view?.branchThreads[emphasizedId]
  const line = thread === undefined ? "var(--primary)" : laneColor(thread)
  // The rule along the bottom is a shadow, not a border, so the full 40 px
  // centre the controls on whole pixels.
  return (
    <div className="flex h-10 flex-none items-center gap-3 px-3 text-[13px] shadow-[inset_0_-1px_0_var(--border)]">
      {worktree && (
        <div className="flex min-w-0 items-center gap-1.5" style={{ "--line": line } as React.CSSProperties}>
          <WorktreeIcon worktree={worktree} className="size-4 flex-none text-subtle-foreground" />
          <span className="truncate font-medium text-foreground" title={worktree.path}>
            {baseName(worktree.path)}
          </span>
          <span className={cn(chip, headEmphasized ? emphasizedTint : "bg-foreground/[0.06] text-secondary-foreground")} aria-busy={checkingOut}>
            {checkingOut ? (
              <LoaderCircle aria-label="Checking out" className="size-3 flex-none animate-spin" />
            ) : worktree.head.kind === "detached" ? (
              <GitCommitHorizontal aria-hidden className="size-3 flex-none" />
            ) : (
              <GitBranch aria-hidden className="size-3 flex-none" />
            )}
            <span className="truncate">{headLabel(worktree, refsById)}</span>
            {head && <AheadBehind ahead={head.ahead} behind={head.behind} />}
          </span>
          {emphasizedOther && (
            <span
              className={cn(chip, emphasizedTint, "pr-0.5")}
              title="Emphasized history"
            >
              <RefKindIcon kind={emphasizedOther.kind} />
              <span className="max-w-48 truncate">{emphasizedOther.shortName}</span>
              <button
                aria-label="Stop emphasizing"
                onClick={onClearEmphasis}
                className="flex size-[18px] flex-none items-center justify-center rounded hover:bg-(--line)/20"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {worktree.operation !== "none" && <span className="flex-none text-xs text-warning">{operationLabels[worktree.operation]}</span>}
          {changes > 0 && (
            <button
              onClick={onShowChanges}
              className="flex-none rounded px-1 text-xs text-subtle-foreground tabular-nums hover:bg-foreground/[0.05] hover:text-foreground"
            >
              {changes} uncommitted {changes === 1 ? "change" : "changes"}
            </button>
          )}
        </div>
      )}
      <div className="ml-auto flex flex-none items-center gap-3 text-xs text-subtle-foreground">
        {actions}
        {view && (
          <span className="tabular-nums">
            {view.totalRows.toLocaleString()} {view.totalRows === 1 ? "commit" : "commits"}
            {view.complete ? "" : "…"}
          </span>
        )}
        <button
          aria-label="Details"
          aria-pressed={detailsShown}
          title={`${detailsShown ? "Hide" : "Show"} details (⌥⌘I)`}
          onClick={onToggleDetails}
          className={cn(
            "-mr-1.5 flex size-7 items-center justify-center rounded-md hover:bg-foreground/[0.05] hover:text-foreground",
            detailsShown && "bg-foreground/[0.06] text-foreground",
          )}
        >
          <PanelRight className="size-4" />
        </button>
      </div>
    </div>
  )
}

const chip = "flex h-[22px] min-w-0 items-center gap-1 rounded-md px-1.5 text-xs"

/** Drawn like the ref's badge in the list: tags have a tag, branches nothing. */
const RefKindIcon = ({ kind }: { kind: Ref["kind"] }) => (kind === "tag" ? <Tag aria-hidden className="size-3 flex-none" /> : null)

const operationLabels: Record<WorktreeOperation, string> = {
  none: "",
  merge: "Merging",
  rebase: "Rebasing",
  cherryPick: "Cherry-picking",
  revert: "Reverting",
  bisect: "Bisecting",
}
