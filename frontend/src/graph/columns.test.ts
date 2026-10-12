import { describe, expect, it } from "vitest"
import { layoutColumns } from "./columns"

describe("layoutColumns", () => {
  it("fits the lanes on screen and keeps every column on a wide pane", () => {
    const columns = layoutColumns(1400, 3)
    expect(columns).toMatchObject({ showAuthor: true, showDate: true, showCommit: true, graph: columns.graphNeeds })
  })

  it("caps a wide graph so the description keeps its room", () => {
    const columns = layoutColumns(632, 70)
    expect(columns.graph).toBe(60)
    expect(columns.graph).toBeLessThan(columns.graphNeeds)
  })

  it("keeps author while the graph has a few lanes, and drops it before going below", () => {
    expect(layoutColumns(930, 20)).toMatchObject({ showAuthor: true, graph: 168 })
    expect(layoutColumns(800, 20)).toMatchObject({ showAuthor: false })
  })

  it("lets a wide graph take a quarter of a wide pane", () => {
    expect(layoutColumns(1200, 30).graph).toBe(294)
  })

  it("gives branch and tag labels a column that grows with the pane, within limits", () => {
    expect(layoutColumns(700, 3)).toMatchObject({ refs: 120, graphLeft: 144 })
    expect(layoutColumns(1200, 3).refs).toBe(168)
    expect(layoutColumns(2400, 3).refs).toBe(200)
    expect(layoutColumns(1200, 3).template).toMatch(/^168px \d+px minmax/)
  })

  it("drops author, then commit, then date as the pane narrows", () => {
    expect(layoutColumns(790, 3)).toMatchObject({ showAuthor: false, showDate: true, showCommit: true })
    expect(layoutColumns(690, 3)).toMatchObject({ showAuthor: false, showDate: true, showCommit: false })
    expect(layoutColumns(610, 3)).toMatchObject({ showAuthor: false, showDate: false, showCommit: false })
  })
})
