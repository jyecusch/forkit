import { Cloud, Tag } from "lucide-react"
import type { Badge } from "@/lib/badges"
import { cn } from "@/lib/utils"

export const laneColor = (thread: number) => `var(--lane-${thread % 8})`

/**
 * A ref on a commit row. Badges are neutral so that a branch never looks
 * like part of another's history: the checked-out branch takes the accent,
 * local branches carry a short tick in their commit's lane colour, remote
 * branches are outlined and tags are marked with a tag.
 */
export const RefBadge = ({ badge, thread, dim }: { badge: Badge; thread: number; dim: boolean }) => {
  const { ref, isHead, inSync } = badge
  const base = "flex h-[18px] max-w-44 min-w-10 shrink items-center gap-1 rounded px-1.5 text-[11px] leading-none font-medium whitespace-nowrap"
  const title = [ref.shortName, isHead && "checked out here", inSync && "in sync with its upstream"].filter(Boolean).join(" · ")
  const label = <span className="truncate">{ref.shortName}</span>
  switch (ref.kind) {
    case "localBranch":
      return (
        <span
          title={title}
          className={cn(base, isHead ? "bg-primary/18 text-primary" : "bg-foreground/[0.07] text-foreground", dim && !isHead && "text-secondary-foreground")}
        >
          {!isHead && <span aria-hidden className="h-2.5 w-0.5 flex-none rounded-full" style={{ background: laneColor(thread) }} />}
          {label}
          {inSync && <Cloud aria-label="in sync with upstream" className="size-3 flex-none opacity-70" />}
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
