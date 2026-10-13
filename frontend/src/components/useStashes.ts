import { Effect } from "effect"
import { useRun } from "@/app/hooks"
import { notify, type Notice } from "@/app/notifications"
import { baseName } from "@/lib/format"
import type { RpcFailure } from "@/model/errors"
import type { Ref, RepoId, Worktree } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import type { PromptSpec } from "./Prompt"

interface StashContext {
  readonly repo: RepoId
  /** The worktree changes are stashed from and stashes applied to. */
  readonly worktree: Worktree | undefined
  readonly prompt: (spec: PromptSpec) => void
}

export interface StashActions {
  /** Stashes the worktree's uncommitted changes, untracked files included. */
  readonly stash: () => void
  readonly apply: (stash: Ref) => void
  /** Applies a stash and drops it, unless its changes conflict. */
  readonly pop: (stash: Ref) => void
  /** Asks, then deletes a stash. */
  readonly drop: (stash: Ref) => void
}

/** Stash actions for the active worktree, each reporting how it went. */
export const useStashes = ({ repo, worktree, prompt }: StashContext): StashActions => {
  const run = useRun()
  const report = <A>(effect: Effect.Effect<A, RpcFailure, Commands>, outcome: (result: A) => Omit<Notice, "id">) =>
    void run(
      effect.pipe(
        Effect.tap((result) => Effect.sync(() => notify(outcome(result)))),
        Effect.catch((error) => Effect.sync(() => notify({ tone: "error", message: error.message }))),
      ),
    )
  const done = (message: string): Omit<Notice, "id"> => ({ tone: "info", message, duration: 2500 })

  const apply = (stash: Ref, pop: boolean) => {
    if (!worktree) return
    const here = baseName(worktree.path)
    report(Commands.use((commands) => commands.applyStash(worktree.id, stash.id, pop)), ({ conflicted }) =>
      conflicted
        ? {
            tone: "error",
            message: `${stash.shortName} conflicted with the files in ${here}. Resolve the conflicts${pop ? "; the stash is kept until you drop it" : ""}.`,
          }
        : done(`${pop ? "Popped" : "Applied"} ${stash.shortName} to ${here}`),
    )
  }

  return {
    stash: () => {
      if (!worktree) return
      report(Commands.use((commands) => commands.stash(worktree.id, "")), () => done(`Stashed the changes in ${baseName(worktree.path)}`))
    },
    apply: (stash) => apply(stash, false),
    pop: (stash) => apply(stash, true),
    drop: (stash) =>
      prompt({
        title: `Drop ${stash.shortName}?`,
        message: "Its changes will be deleted, and only git's own recovery tools can bring them back.",
        actions: [
          {
            label: "Drop",
            tone: "destructive",
            run: () => report(Commands.use((commands) => commands.dropStash(repo, stash.id)), () => done(`Dropped ${stash.shortName}`)),
          },
        ],
      }),
  }
}
