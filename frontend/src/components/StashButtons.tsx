import { Archive, ArchiveRestore } from "lucide-react"
import type { Operation, Ref, Worktree } from "@/model/model.gen"
import { ActionButton } from "./RemoteActions"
import type { StashActions } from "./useStashes"

interface StashButtonsProps {
  readonly worktree: Worktree | undefined
  /** Uncommitted changes in the worktree, which stashing saves. */
  readonly changes: number
  /** The newest stash, which popping applies. */
  readonly newest: Ref | undefined
  readonly operations: ReadonlyArray<Operation>
  readonly stashes: StashActions
}

/** Stash the active worktree's changes, or pop the newest stash into it. */
export const StashButtons = ({ worktree, changes, newest, operations, stashes }: StashButtonsProps) => {
  const running = (kind: Operation["kind"]) => operations.find((op) => op.state === "running" && op.kind === kind && op.worktreeId === worktree?.id)
  const busy = operations.some((op) => op.state === "running" && op.worktreeId === worktree?.id)
  return (
    <div className="flex flex-none items-center gap-0.5">
      <ActionButton
        label="Stash"
        title={changes > 0 ? "Stash the uncommitted changes, untracked files included" : "There are no changes to stash"}
        disabled={changes === 0 || busy}
        operation={running("stash")}
        onClick={stashes.stash}
        icon={<Archive className="size-3.5" />}
      />
      <ActionButton
        label="Pop"
        title={newest ? `Pop ${newest.shortName}, the newest stash` : "There are no stashes to pop"}
        disabled={!newest || busy}
        operation={running("applyStash")}
        onClick={() => newest && stashes.pop(newest)}
        icon={<ArchiveRestore className="size-3.5" />}
      />
    </div>
  )
}
