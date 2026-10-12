import type { Ref, Worktree } from "@/model/model.gen"
import { shortOid } from "./format"

/** Files with any kind of uncommitted change. */
export const changeCount = (worktree: Worktree) => {
  const { staged, unstaged, untracked, conflicted } = worktree.statusSummary
  return staged + unstaged + untracked + conflicted
}

/** What a worktree has checked out: a branch name, or where HEAD is detached. */
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
