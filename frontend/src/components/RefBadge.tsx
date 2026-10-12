import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import type { Ref } from "@/model/model.gen"

export const laneColor = (thread: number) => `var(--lane-${thread % 8})`

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`

/**
 * A ref drawn in its commit's thread colour: filled for local branches,
 * outlined for remote branches and dashed for tags.
 */
export const RefBadge = ({ refEntity, thread, dim, isHead }: { refEntity: Ref; thread: number; dim: boolean; isHead: boolean }) => {
  const color = laneColor(thread)
  const style: CSSProperties = { color }
  switch (refEntity.kind) {
    case "localBranch":
      style.background = tint(color, dim ? 10 : 22)
      break
    case "remoteBranch":
      style.border = `1px solid ${tint(color, 45)}`
      break
    default:
      style.border = `1px dashed ${tint(color, 70)}`
  }
  return (
    <span
      className={cn("max-w-48 min-w-12 shrink truncate rounded px-1.5 text-[11px] leading-[18px] font-medium whitespace-nowrap", dim && "opacity-60")}
      style={style}
      title={refEntity.shortName}
    >
      {isHead && "HEAD → "}
      {refEntity.shortName}
    </span>
  )
}
