import { Option } from "effect"
import { Check, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { useRun } from "@/app/hooks"
import { notify } from "@/app/notifications"
import { Button } from "@/components/ui/button"
import { shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { WorktreeId } from "@/model/model.gen"
import { Rpc } from "@/services/Rpc"

interface Draft {
  readonly message: string
  readonly amend: boolean
  /** The message an amend started from, so turning amend off can clear it again. */
  readonly amending?: string
}

/** Unfinished messages, per worktree, kept while the app is open. */
const drafts = new Map<WorktreeId, Draft>()

interface CommitComposerProps {
  readonly worktree: WorktreeId
  /** How many files are staged; with none, only an amend can be committed. */
  readonly staged: number
}

/**
 * Writes and records a commit of a worktree's staged changes, or amends its
 * last commit. Command-Return commits.
 */
export const CommitComposer = ({ worktree, staged }: CommitComposerProps) => {
  const run = useRun()
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(worktree) ?? { message: "", amend: false })
  const [busy, setBusy] = useState(false)
  const setDraft = (next: Draft) => {
    drafts.set(worktree, next)
    setDraftState(next)
  }
  useEffect(() => setDraftState(drafts.get(worktree) ?? { message: "", amend: false }), [worktree])

  const canCommit = !busy && draft.message.trim() !== "" && (staged > 0 || draft.amend)
  const [summary = ""] = draft.message.split("\n")

  const toggleAmend = async (amend: boolean) => {
    if (!amend) {
      // Leave anything the user wrote; clear only the message amend brought in.
      setDraft({ message: draft.message === draft.amending ? "" : draft.message, amend: false })
      return
    }
    if (draft.message.trim() !== "") {
      setDraft({ ...draft, amend: true })
      return
    }
    const message = Option.getOrElse(await run(Rpc.use((rpc) => rpc.headMessage(worktree))), () => "")
    setDraft({ message, amend: true, amending: message })
  }

  const commit = async () => {
    if (!canCommit) return
    setBusy(true)
    const result = await run(Rpc.use((rpc) => rpc.commit(worktree, draft.message, draft.amend)))
    setBusy(false)
    if (Option.isSome(result)) {
      setDraft({ message: "", amend: false })
      notify({ tone: "info", message: `${draft.amend ? "Amended" : "Committed"} ${shortOid(result.value)}`, duration: 2500 })
    }
  }

  return (
    <form
      className="flex flex-none flex-col gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault()
        void commit()
      }}
    >
      <textarea
        value={draft.message}
        onChange={(event) => setDraft({ ...draft, message: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void commit()
          }
        }}
        placeholder="Commit message"
        aria-label="Commit message"
        rows={3}
        className="max-h-48 min-h-[4.5rem] w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px] leading-5 placeholder:text-subtle-foreground focus-visible:outline-offset-0"
      />
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary-foreground select-none">
          <span className="relative flex size-3.5">
            <input
              type="checkbox"
              checked={draft.amend}
              onChange={(event) => void toggleAmend(event.target.checked)}
              className="peer size-3.5 appearance-none rounded-[3px] border border-foreground/30 checked:border-primary checked:bg-primary"
            />
            <Check aria-hidden className="pointer-events-none absolute inset-0 hidden size-3.5 p-px text-primary-foreground peer-checked:block" />
          </span>
          Amend last commit
        </label>
        {summary.length > 72 && (
          <span title="Summaries over 72 characters are cut short in many tools" className="text-[11px] text-warning tabular-nums">
            {summary.length}
          </span>
        )}
        <Button type="submit" size="sm" className={cn("ml-auto", busy && "pointer-events-none")} disabled={!canCommit} title="Commit (⌘↩)">
          {busy && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
          {draft.amend ? "Amend" : staged > 0 ? `Commit ${staged} ${staged === 1 ? "file" : "files"}` : "Commit"}
        </Button>
      </div>
    </form>
  )
}
