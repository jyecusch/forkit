import { CircleCheck, Tag } from "lucide-react"
import { remoteBranchName, type Badge } from "@/lib/badges"
import { baseName } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Worktree } from "@/model/model.gen"
import { AheadBehind } from "./AheadBehind"
import { WorktreeIcon } from "./WorktreeIcon"

export const laneColor = (thread: number) => `var(--lane-${thread % 8})`

/** The emphasized ref's tint, in the colour set as `--line`. */
export const emphasizedTint =
  "bg-[color-mix(in_srgb,var(--line)_14%,transparent)] text-(--line) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--line)_45%,transparent)]"

interface RefBadgeProps extends Omit<React.ComponentProps<"span">, "title" | "className" | "children"> {
  readonly badge: Badge
  /** The worktree the branch is checked out in, if any. */
  readonly worktree: Worktree | undefined
  readonly thread: number
  readonly dim: boolean
  /** The row is selected, so accent fills go solid to keep their contrast. */
  readonly selected: boolean
  /** The row's leading badge, which keeps its full name while others shrink. */
  readonly primary: boolean
}

/**
 * A ref on a commit row. The branch checked out in the active worktree is
 * filled green with a check, whatever else it is. The emphasized ref is
 * filled with its line's colour; other local branches carry a dot in it, so a label leads to its
 * line. A branch checked out in a worktree carries that worktree's icon
 * instead, local branches how far they are from their upstream, remote
 * branches an outline in the theme's remote colour and tags a tag in its tag
 * colour.
 */
export const RefBadge = ({ badge, worktree, thread, dim, selected, primary, style, ...spanProps }: RefBadgeProps) => {
  const { ref, isHead, isEmphasized, inSync, sameOnOtherRemotes } = badge
  // Same-named branches on several remotes read as one, with a count.
  const merged = ref.kind === "remoteBranch" && sameOnOtherRemotes.length > 0
  const name = merged ? remoteBranchName(ref) : ref.shortName
  const title = [
    [ref, ...sameOnOtherRemotes].map((r) => r.shortName).join(", "),
    worktree && (isHead ? "checked out here" : `checked out in ${baseName(worktree.path)}`),
    isEmphasized && "emphasized",
    inSync && "in sync with its upstream",
  ]
    .filter(Boolean)
    .join(" · ")
  const tone = isHead
    ? "bg-head text-background"
    : isEmphasized
    ? selected
      ? "bg-(--line) text-background"
      : emphasizedTint
    : {
        localBranch: cn("bg-foreground/[0.07]", dim ? "text-secondary-foreground" : "text-foreground"),
        remoteBranch: cn("border border-remote/35 text-remote", dim && "opacity-75"),
        tag: cn("bg-tag/12 text-tag", dim && "opacity-75"),
        stash: "bg-foreground/[0.05] text-secondary-foreground",
      }[ref.kind]
  return (
    <span
      {...spanProps}
      title={title}
      className={cn(
        "flex h-[18px] max-w-44 items-center gap-1 rounded px-1.5 text-[11px] leading-none font-medium whitespace-nowrap",
        primary ? "min-w-0 flex-[0_1_auto]" : "min-w-12 flex-[0_100_auto]",
        tone,
      )}
      style={{ ...style, "--line": laneColor(thread) } as React.CSSProperties}
    >
      {isHead ? (
        <CircleCheck aria-hidden className="size-3 flex-none" />
      ) : worktree ? (
        <WorktreeIcon worktree={worktree} className="size-3 flex-none" />
      ) : ref.kind === "localBranch" && !isEmphasized ? (
        <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: laneColor(thread) }} />
      ) : ref.kind === "tag" ? (
        <Tag aria-hidden className="size-3 flex-none" />
      ) : null}
      <span className="truncate">{name}</span>
      {merged && <span className="flex-none text-[10px] opacity-70 tabular-nums">×{sameOnOtherRemotes.length + 1}</span>}
      {primary && ref.kind === "localBranch" && <AheadBehind ahead={ref.ahead} behind={ref.behind} plain={isHead || (isEmphasized && selected)} />}
    </span>
  )
}
