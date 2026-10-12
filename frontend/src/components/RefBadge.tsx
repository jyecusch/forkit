import { Check, Tag } from "lucide-react"
import { remoteBranchName, type Badge } from "@/lib/badges"
import { cn } from "@/lib/utils"
import { AheadBehind } from "./AheadBehind"

export const laneColor = (thread: number) => `var(--lane-${thread % 8})`

interface RefBadgeProps {
  readonly badge: Badge
  readonly thread: number
  readonly dim: boolean
  /** The row is selected, so accent fills go solid to keep their contrast. */
  readonly selected: boolean
  /** The row's leading badge, which keeps its full name while others shrink. */
  readonly primary: boolean
}

/**
 * A ref on a commit row. Badges are neutral so that a branch never looks
 * like part of another's history. The accent means one thing everywhere:
 * the emphasized ref. The checked-out branch carries a check, local
 * branches a dot in their commit's lane colour and how far they are from
 * their upstream, remote branches an outline in the theme's remote colour
 * and tags a tag in its tag colour.
 */
export const RefBadge = ({ badge, thread, dim, selected, primary }: RefBadgeProps) => {
  const { ref, isHead, isEmphasized, inSync, sameOnOtherRemotes } = badge
  // Same-named branches on several remotes read as one, with a count.
  const merged = ref.kind === "remoteBranch" && sameOnOtherRemotes.length > 0
  const name = merged ? remoteBranchName(ref) : ref.shortName
  const title = [
    [ref, ...sameOnOtherRemotes].map((r) => r.shortName).join(", "),
    isHead && "checked out here",
    isEmphasized && "emphasized",
    inSync && "in sync with its upstream",
  ]
    .filter(Boolean)
    .join(" · ")
  const tone = isEmphasized
    ? selected
      ? "bg-primary text-primary-foreground"
      : "bg-primary/12 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_40%,transparent)]"
    : {
        localBranch: cn("bg-foreground/[0.07]", dim ? "text-secondary-foreground" : "text-foreground"),
        remoteBranch: cn("border border-remote/35 text-remote", dim && "opacity-75"),
        tag: cn("bg-tag/12 text-tag", dim && "opacity-75"),
        stash: "bg-foreground/[0.05] text-secondary-foreground",
      }[ref.kind]
  return (
    <span
      title={title}
      className={cn(
        "flex h-[18px] max-w-44 items-center gap-1 rounded px-1.5 text-[11px] leading-none font-medium whitespace-nowrap",
        primary ? "min-w-0 flex-[0_1_auto]" : "min-w-12 flex-[0_100_auto]",
        tone,
      )}
    >
      {isHead ? (
        <Check aria-label="checked out" className="size-3 flex-none" />
      ) : ref.kind === "localBranch" && !isEmphasized ? (
        <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: laneColor(thread) }} />
      ) : ref.kind === "tag" ? (
        <Tag aria-hidden className="size-3 flex-none" />
      ) : null}
      <span className="truncate">{name}</span>
      {merged && <span className="flex-none text-[10px] opacity-70 tabular-nums">×{sameOnOtherRemotes.length + 1}</span>}
      {primary && ref.kind === "localBranch" && <AheadBehind ahead={ref.ahead} behind={ref.behind} plain={isEmphasized && selected} />}
    </span>
  )
}
