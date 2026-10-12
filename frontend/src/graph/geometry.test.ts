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
        { fromLane: lane, toLane: 0, threadId: lane, kind: lane === 0 ? "straight" : "merge", onEmphasized },
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
    headOids: new Set(["c2"]),
    anyEmphasis: true,
  })

  it("draws emphasized lines last so they sit on top", () => {
    expect(result.segments.map((s) => s.emphasized)).toEqual([false, true, true])
  })

  it("positions rows relative to the canvas origin", () => {
    expect(result.dots[1]).toMatchObject({ x: laneX(1), y: rowHeight / 2 })
  })

  it("draws merges and checked-out commits as rings", () => {
    expect(result.dots.map((d) => d.hollow)).toEqual([true, false, true])
  })
})
