import { describe, expect, it } from "vitest"
import type { LoadedRow } from "@/services/GraphData"
import { geometry, laneX, rowHeight } from "./geometry"

const row = (index: number, lane: number, onEmphasized: boolean, parents = 1): LoadedRow =>
  ({
    row: {
      index,
      oid: `c${index}`,
      lane,
      threadId: lane,
      onEmphasized,
      refIds: [],
      edges: [
        { fromLane: lane, toLane: 0, threadId: lane, kind: lane === 0 ? "straight" : "merge" },
      ],
    },
    commit: { oid: `c${index}`, parents: Array.from({ length: parents }, (_, i) => `p${i}`) },
  }) as unknown as LoadedRow

describe("geometry", () => {
  const rows = [row(0, 0, true, 2), row(1, 1, false), row(2, 0, true)]
  const result = geometry({
    first: 0,
    last: 2,
    originY: rowHeight,
    offsetX: 0,
    rowAt: (i) => rows[i],
    activeHead: "c2",
    headOids: new Set(["c1", "c2"]),
  })

  it("positions rows relative to the canvas origin", () => {
    expect(result.dots.find((d) => d.x === laneX(1))).toMatchObject({ y: rowHeight / 2 })
  })

  it("tells merges and checked-out commits apart, the active worktree's from the rest", () => {
    const shapes = Object.fromEntries(result.dots.map((d) => [d.y, d.shape]))
    expect(Object.values(shapes).sort()).toEqual(["head", "merge", "worktree"])
  })
})

describe("geometry of a stash", () => {
  // A stash's commit has its own commits as extra parents, but it is no merge.
  const stash = row(0, 1, false, 3)
  const stashRow = { ...stash, row: { ...stash.row, stash: true, edges: [{ fromLane: 1, toLane: 0, threadId: -2, kind: "merge", stash: true }] } } as LoadedRow
  const result = geometry({ first: 0, last: 1, originY: 0, offsetX: 0, rowAt: (i) => [stashRow, row(1, 0, false)][i], activeHead: undefined, headOids: new Set() })

  it("is drawn as a stash, with a stash line to the commit it was made on", () => {
    expect(result.dots[0]).toMatchObject({ shape: "stash" })
    expect(result.segments[0]).toMatchObject({ line: "stash" })
    expect(result.segments[1]).toMatchObject({ line: "history" })
  })
})
