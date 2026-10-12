import { Folder, GitBranch, LoaderCircle, PanelRight, Tag, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { baseName } from "@/lib/format"
import { changeCount, headLabel } from "@/lib/worktree"
import type { GraphView, Ref, Worktree, WorktreeOperation } from "@/model/model.gen"

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
  readonly detailsShown: boolean
  readonly onToggleDetails: () => void
}

/**
 * The panel's second header level: which worktree and branch the view is
 * about, and what the graph is showing.
 */
export const ViewHeader = ({ worktree, refsById, headEmphasized, emphasizedOther, onClearEmphasis, view, checkingOut, detailsShown, onToggleDetails }: ViewHeaderProps) => {
  const changes = worktree ? changeCount(worktree) : 0
  const head = worktree?.head.refId ? refsById.get(worktree.head.refId) : undefined
  return (
    <div className="flex h-10 flex-none items-center gap-3 border-b px-3 text-[13px]">
      {worktree && (
        <div className="flex min-w-0 items-center gap-1.5">
          <Folder aria-hidden className="size-4 flex-none text-subtle-foreground" />
          <span className="truncate font-medium text-foreground" title={worktree.path}>
            {baseName(worktree.path)}
          </span>
          <span className={cn(chip, headEmphasized ? emphasizedChip : "bg-foreground/[0.06] text-secondary-foreground")} aria-busy={checkingOut}>
            {checkingOut ? (
              <LoaderCircle aria-label="Checking out" className="size-3 flex-none animate-spin" />
            ) : (
              <GitBranch aria-hidden className="size-3 flex-none" />
            )}
            <span className="truncate">{headLabel(worktree, refsById)}</span>
            {head && Boolean(head.ahead || head.behind) && (
              <span className="flex-none opacity-70 tabular-nums" title="Ahead of and behind its upstream">
                {head.ahead ? `↑${head.ahead}` : ""}
                {head.ahead && head.behind ? " " : ""}
                {head.behind ? `↓${head.behind}` : ""}
              </span>
            )}
          </span>
          {emphasizedOther && (
            <span
              className={cn(chip, emphasizedChip, "pr-0.5")}
              title="Emphasized history"
            >
              <RefKindIcon kind={emphasizedOther.kind} />
              <span className="max-w-48 truncate">{emphasizedOther.shortName}</span>
              <button
                aria-label="Stop emphasizing"
                onClick={onClearEmphasis}
                className="flex size-[18px] flex-none items-center justify-center rounded hover:bg-primary/20"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {worktree.operation !== "none" && <span className="flex-none text-xs text-warning">{operationLabels[worktree.operation]}</span>}
          {changes > 0 && (
            <span className="flex-none text-xs text-subtle-foreground tabular-nums">
              {changes} uncommitted {changes === 1 ? "change" : "changes"}
            </span>
          )}
        </div>
      )}
      <div className="ml-auto flex flex-none items-center gap-3 text-xs text-subtle-foreground">
        {view && (
          <span className="tabular-nums">
            {view.totalRows.toLocaleString()} {view.totalRows === 1 ? "commit" : "commits"}
            {view.complete ? "" : "…"}
          </span>
        )}
        <button
          aria-label={detailsShown ? "Hide details" : "Show details"}
          aria-pressed={detailsShown}
          title={detailsShown ? "Hide details" : "Show details"}
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
/** The accent marks the emphasized ref, as its badges do in the list. */
const emphasizedChip = "bg-primary/12 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_40%,transparent)]"

const RefKindIcon = ({ kind }: { kind: Ref["kind"] }) =>
  kind === "tag" ? <Tag aria-hidden className="size-3 flex-none" /> : <GitBranch aria-hidden className="size-3 flex-none" />

const operationLabels: Record<WorktreeOperation, string> = {
  none: "",
  merge: "Merging",
  rebase: "Rebasing",
  cherryPick: "Cherry-picking",
  revert: "Reverting",
  bisect: "Bisecting",
}
