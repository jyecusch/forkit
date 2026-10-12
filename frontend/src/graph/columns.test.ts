import { describe, expect, it } from "vitest"
import { avatarColumn, columnGap, layoutColumns, listInset } from "./columns"

describe("layoutColumns", () => {
  it("fits the lanes on screen on a wide pane", () => {
    const columns = layoutColumns(1400, 3)
    expect(columns.graph).toBe(columns.graphNeeds)
  })

  it("caps a wide graph so the description keeps its room", () => {
    const columns = layoutColumns(632, 70)
    expect(columns.graph).toBeLessThan(columns.graphNeeds)
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
    const columns = layoutColumns(1400, 3, { refs: 240, graph: 300 })
    expect(columns).toMatchObject({ refs: 240, graph: 300, graphLeft: 264 })
    expect(columns.template).toBe(`240px 300px minmax(0,1fr) ${avatarColumn}px`)
  })

  it("keeps the description's room even from a graph the user widened", () => {
    const c = layoutColumns(800, 3, { graph: 2000 })
    const description = 800 - listInset * 2 - c.refs - c.graph - avatarColumn - 3 * columnGap
    expect(c.graph).toBeLessThan(2000)
    expect(description).toBeGreaterThanOrEqual(280)
  })
})
