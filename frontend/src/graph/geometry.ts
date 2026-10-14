import type { EdgeKind } from "@/model/model.gen"
import type { LoadedRow } from "@/services/GraphData"

/** Sizes the graph is drawn at, in CSS pixels. */
export const rowHeight = 28
export const laneWidth = 18
export const gutter = 12

export const laneX = (lane: number) => gutter + lane * laneWidth

/** A line from one row's lane to the next row's. */
export interface Segment {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly kind: EdgeKind
  readonly thread: number
  /**
   * What the line belongs to: history in its thread's colour, or the line
   * from uncommitted changes or a stash to the commit they build on, drawn
   * lighter and dashed.
   */
  readonly line: "history" | "uncommitted" | "stash"
}

/**
 * How a commit is drawn: ordinary commits are solid and merges are rings.
 * The active worktree's checked-out commit is solid with an outer ring;
 * other worktrees' are solid with a fainter, thinner one. A stash is a
 * hollow square, as it is not part of history.
 */
export type DotShape = "commit" | "merge" | "head" | "worktree" | "stash"

export interface Dot {
  readonly x: number
  readonly y: number
  readonly thread: number
  readonly shape: DotShape
}

export interface Geometry {
  readonly segments: ReadonlyArray<Segment>
  readonly dots: ReadonlyArray<Dot>
}

/**
 * Lays out the lines and dots for rows [first, last], positioned relative to
 * originY, the list position of the canvas's top edge. Rows that have not
 * loaded yet are skipped.
 */
export const geometry = (options: {
  readonly first: number
  readonly last: number
  readonly originY: number
  readonly offsetX: number
  readonly rowAt: (index: number) => LoadedRow | undefined
  /** The active worktree's checked-out commit. */
  readonly activeHead: string | undefined
  /** Every worktree's checked-out commit. */
  readonly headOids: ReadonlySet<string>
}): Geometry => {
  const { first, last, originY, offsetX, rowAt, activeHead, headOids } = options
  const centerY = (index: number) => index * rowHeight + rowHeight / 2 - originY
  const x = (lane: number) => laneX(lane) - offsetX
  const segments: Array<Segment> = []
  const dots: Array<Dot> = []
  for (let index = Math.max(0, first - 1); index <= last; index++) {
    const loaded = rowAt(index)
    if (!loaded) {
      continue
    }
    const { row, commit } = loaded
    for (const edge of row.edges) {
      segments.push({
        x1: x(edge.fromLane),
        y1: centerY(index),
        x2: x(edge.toLane),
        y2: centerY(index + 1),
        kind: edge.kind,
        thread: edge.threadId,
        line: edge.uncommitted ? "uncommitted" : edge.stash ? "stash" : "history",
      })
    }
    dots.push({
      x: x(row.lane),
      y: centerY(index),
      thread: row.threadId,
      shape: row.stash
        ? "stash"
        : row.oid === activeHead
          ? "head"
          : headOids.has(row.oid)
            ? "worktree"
            : commit.parents.length > 1
              ? "merge"
              : "commit",
    })
  }
  return { segments, dots }
}

/** The widest lane any loaded row in [first, last] draws on, or -1 if none. */
export const widestLane = (first: number, last: number, rowAt: (index: number) => LoadedRow | undefined): number => {
  let widest = -1
  for (let index = Math.max(0, first - 1); index <= last; index++) {
    const loaded = rowAt(index)
    if (!loaded) continue
    widest = Math.max(widest, loaded.row.lane)
    for (const edge of loaded.row.edges) widest = Math.max(widest, edge.fromLane, edge.toLane)
  }
  return widest
}
