import { cn } from "@/lib/utils"

/**
 * How far a branch is from its upstream: commits it has that the upstream
 * lacks in green, and commits it is missing in the theme's warning colour.
 * Nothing when it is in step.
 */
interface AheadBehindProps {
  readonly ahead: number | undefined
  readonly behind: number | undefined
  /** On a solid accent fill, the counts take its text colour instead. */
  readonly plain?: boolean
  readonly className?: string
}

export const AheadBehind = ({ ahead, behind, plain = false, className }: AheadBehindProps) => {
  if (!ahead && !behind) return null
  const title = [ahead && `${ahead} ahead of upstream`, behind && `${behind} behind upstream`].filter(Boolean).join(", ")
  return (
    <span title={title} className={cn("flex flex-none gap-1 tabular-nums", className)}>
      {ahead ? <span className={plain ? undefined : "text-success"}>↑{ahead}</span> : null}
      {behind ? <span className={plain ? undefined : "text-warning"}>↓{behind}</span> : null}
    </span>
  )
}
