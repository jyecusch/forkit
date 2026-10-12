import { Effect } from "effect"
import { useRun } from "@/app/hooks"
import { notify } from "@/app/notifications"
import { baseName } from "@/lib/format"
import type { CheckoutMode, DirtyCheckout, Ref, RepoId, Worktree } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import type { PromptSpec } from "./Prompt"

const modeFor: Record<DirtyCheckout, CheckoutMode> = { ask: "safe", stash: "stash", carry: "carry" }

interface CheckoutContext {
  readonly repo: RepoId
  readonly refs: ReadonlyArray<Ref>
  readonly worktrees: ReadonlyArray<Worktree>
  readonly dirtyCheckout: DirtyCheckout
  readonly prompt: (spec: PromptSpec) => void
  readonly selectWorktree: (worktree: Worktree) => void
}

/**
 * Returns the double-click action for refs: confirmations for remote
 * branches and tags, then a checkout that asks what to do with uncommitted
 * changes and offers to switch to a worktree that already has the branch.
 */
export const useCheckout = ({ repo, refs, worktrees, dirtyCheckout, prompt, selectWorktree }: CheckoutContext) => {
  const run = useRun()

  const attempt = (ref: Ref, worktree: Worktree, mode: CheckoutMode) =>
    void run(
      Commands.use((commands) => commands.checkout(repo, worktree.id, ref.id, mode)).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const target = result.branch ? result.branch.slice(result.branch.indexOf("refs/heads/") + "refs/heads/".length) : ref.shortName
            notify({
              tone: "info",
              message: result.reapplyConflicted
                ? `Switched ${baseName(worktree.path)} to ${target}, but your changes conflicted. They are kept in the stash.`
                : `Switched ${baseName(worktree.path)} to ${target}`,
            })
          }),
        ),
        Effect.catchTags({
          DirtyWorktreeError: (error) =>
            Effect.sync(() =>
              prompt({
                title: `Switch to ${ref.shortName}?`,
                message: `${error.message} Choose what happens to them before checking out.`,
                actions: [
                  { label: "Bring changes", run: () => attempt(ref, worktree, "carry") },
                  { label: "Stash and switch", tone: "primary", run: () => attempt(ref, worktree, "stash") },
                ],
              }),
            ),
          BranchCheckedOutElsewhereError: (error) =>
            Effect.sync(() => {
              const other = worktrees.find((wt) => wt.id === error.details["worktreeId"])
              notify({
                tone: "info",
                message: other ? `${ref.shortName} is checked out in worktree ${baseName(other.path)}` : error.message,
                ...(other && { action: { label: "Switch to it", run: () => selectWorktree(other) } }),
              })
            }),
          OperationInProgressError: (error) => Effect.sync(() => notify({ tone: "error", message: error.message })),
        }),
      ),
    )

  return (ref: Ref, worktree: Worktree | undefined) => {
    if (!worktree) return
    const here = baseName(worktree.path)
    const mode = modeFor[dirtyCheckout]
    switch (ref.kind) {
      case "localBranch":
        return attempt(ref, worktree, mode)
      case "remoteBranch": {
        const tracking = refs.find((r) => r.kind === "localBranch" && r.upstreamRefId === ref.id)
        if (tracking) {
          return attempt(tracking, worktree, mode)
        }
        const name = ref.shortName.slice(ref.shortName.indexOf("/") + 1)
        return prompt({
          title: `Check out ${ref.shortName}?`,
          message: `This creates a local branch ${name} that tracks ${ref.shortName} and checks it out in ${here}.`,
          actions: [{ label: "Create and check out", tone: "primary", run: () => attempt(ref, worktree, mode) }],
        })
      }
      default:
        return prompt({
          title: `Check out ${ref.shortName}?`,
          message: `${here} will be on a detached HEAD at ${ref.shortName}. Commits made there belong to no branch until you create one.`,
          actions: [{ label: "Check out", tone: "primary", run: () => attempt(ref, worktree, mode) }],
        })
    }
  }
}
