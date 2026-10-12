import { House, TreeDeciduous } from "lucide-react"
import type { Worktree } from "@/model/model.gen"

/** The main worktree is home; every linked worktree is a tree. */
export const WorktreeIcon = ({ worktree, className }: { worktree: Worktree; className: string }) => {
  const Icon = worktree.isMain ? House : TreeDeciduous
  return <Icon aria-hidden className={className} />
}
