import { Cloud, Tag } from "lucide-react"
import type { Badge } from "@/lib/badges"
import { cn } from "@/lib/utils"

export const laneColor = (thread: number) => `var(--lane-${thread % 8})`

/**
 * A ref on a commit row. Badges are neutral so that a branch never looks
 * like part of another's history: the checked-out branch takes the accent,
 * local branches carry a dot in their commit's lane colour, remote
 * branches are outlined and tags are marked with a tag.
 */
interface RefBadgeProps {
  readonly badge: Badge
  readonly thread: number
  readonly dim: boolean
  /** The row's leading badge, which keeps its full name while others shrink. */
  readonly primary: boolean
}

export const RefBadge = ({ badge, thread, dim, primary }: RefBadgeProps) => {
  const { ref, isHead, inSync } = badge
  const base = cn(
    "flex h-[18px] max-w-44 items-center gap-1 rounded px-1.5 text-[11px] leading-none font-medium whitespace-nowrap",
    primary ? "min-w-0 flex-[0_1_auto]" : "min-w-12 flex-[0_100_auto]",
  )
  const title = [ref.shortName, isHead && "checked out here", inSync && "in sync with its upstream"].filter(Boolean).join(" · ")
  const label = <span className="truncate">{ref.shortName}</span>
  switch (ref.kind) {
    case "localBranch":
      return (
        <span
          title={title}
          className={cn(base, isHead ? "bg-primary/18 text-primary" : "bg-foreground/[0.07] text-foreground", dim && !isHead && "text-secondary-foreground")}
        >
          {!isHead && <span aria-hidden className="size-1.5 flex-none rounded-full" style={{ background: laneColor(thread) }} />}
          {label}
          {inSync && primary && <Cloud aria-label="in sync with upstream" className="size-3 flex-none opacity-70" />}
        </span>
      )
    case "remoteBranch":
      return (
        <span title={title} className={cn(base, "border border-foreground/15 text-secondary-foreground")}>
          {label}
        </span>
      )
    default:
      return (
        <span title={title} className={cn(base, "bg-foreground/[0.05] text-secondary-foreground")}>
          <Tag aria-hidden className="size-3 flex-none" />
          {label}
        </span>
      )
  }
}
