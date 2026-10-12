import type { Worktree } from "@/model/model.gen"

/** Files with any kind of uncommitted change. */
export const changeCount = (worktree: Worktree) => {
  const { staged, unstaged, untracked, conflicted } = worktree.statusSummary
  return staged + unstaged + untracked + conflicted
}
