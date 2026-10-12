import { describe, expect, it } from "vitest"
import { columnGap, layoutColumns, listInset } from "./columns"

describe("layoutColumns", () => {
  it("fits the lanes on screen and keeps the author on a wide pane", () => {
    const columns = layoutColumns(1400, 3)
    expect(columns).toMatchObject({ showAuthor: true, graph: columns.graphNeeds })
  })

  it("caps a wide graph so the description keeps its room", () => {
    const columns = layoutColumns(632, 70)
    expect(columns.graph).toBeLessThan(columns.graphNeeds)
  })

  it("keeps author while the graph has a few lanes, and drops it before going below", () => {
    expect(layoutColumns(740, 20)).toMatchObject({ showAuthor: true, graph: 168 })
    expect(layoutColumns(620, 20)).toMatchObject({ showAuthor: false })
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

  it("uses the widths the user gave columns", () => {
    const columns = layoutColumns(1400, 3, { refs: 240, graph: 300, author: 150 })
    expect(columns).toMatchObject({ refs: 240, graph: 300, author: 150, graphLeft: 264 })
    expect(columns.template).toBe("240px 300px minmax(0,1fr) 150px")
  })

  it("keeps the description's room even from a graph the user widened", () => {
    const c = layoutColumns(800, 3, { graph: 2000 })
    const columns = c.showAuthor ? 4 : 3
    const description = 800 - listInset * 2 - c.refs - c.graph - (c.showAuthor ? c.author : 0) - (columns - 1) * columnGap
    expect(c.graph).toBeLessThan(2000)
    expect(description).toBeGreaterThanOrEqual(280)
  })
})
