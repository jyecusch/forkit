import { Option } from "effect"
import { LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useRun } from "@/app/hooks"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Ref, Repo } from "@/model/model.gen"
import { Commands } from "@/services/Commands"

interface NewWorktreeDialogProps {
  readonly repo: Repo
  /** Where the new worktree starts; undefined closes the dialog. */
  readonly base: Ref | undefined
  readonly onClose: () => void
}

/** Creates a worktree on a new branch, or on the base branch itself. */
export const NewWorktreeDialog = ({ repo, base, onClose }: NewWorktreeDialogProps) => {
  const run = useRun()
  const [branch, setBranch] = useState("")
  const [parent, setParent] = useState<string>()
  const [busy, setBusy] = useState(false)
  const branchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setBranch("")
    setParent(undefined)
  }, [base])

  const canUseBase = base?.kind === "localBranch" && !base.checkedOutInWorktreeId
  const effectiveBranch = branch.trim() || (canUseBase ? base.shortName : "")
  const folder = `${repo.name}-${(effectiveBranch || "feature/my-change").replace(/[^A-Za-z0-9._-]+/g, "-")}`
  const path = parent ? `${parent}/${folder}` : ""

  const create = async () => {
    if (!base || !effectiveBranch || busy) return
    setBusy(true)
    const created = await run(Commands.use((commands) => commands.createWorktree(repo.id, base.id, branch.trim(), path)))
    setBusy(false)
    if (Option.isSome(created)) onClose()
  }

  const choose = async () => {
    const chosen = Option.flatten(await run(Commands.use((commands) => commands.chooseWorktreeParent())))
    if (Option.isSome(chosen)) setParent(chosen.value)
  }

  return (
    <Dialog open={base !== undefined} onOpenChange={(open) => !open && onClose()}>
      {base && (
        <DialogContent
          className="sm:max-w-[480px]"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            branchInput.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>New worktree from {base.shortName}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1.5">
            <span>New branch</span>
            <Input
              ref={branchInput}
              value={branch}
              placeholder={canUseBase ? `Leave empty to check out ${base.shortName}` : "feature/my-change"}
              onChange={(event) => setBranch(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void create()}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span>Location</span>
            <div className="flex h-7 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary-foreground" title={path || `Next to the main worktree, in ${folder}`}>
                {path || `…/${folder}`}
              </span>
              <Button variant="ghost" size="sm" className="text-primary" onClick={() => void choose()}>
                Choose…
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!effectiveBranch} aria-busy={busy} onClick={() => void create()}>
              {busy && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
              {busy ? "Creating…" : "Create worktree"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
