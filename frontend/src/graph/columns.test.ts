import { describe, expect, it } from "vitest"
import { layoutColumns } from "./columns"

describe("layoutColumns", () => {
  it("fits the lanes on screen and keeps every column on a wide pane", () => {
    const columns = layoutColumns(1400, 3)
    expect(columns).toMatchObject({ showAuthor: true, showDate: true, showCommit: true, graph: columns.graphNeeds })
  })

  it("caps a wide graph so the description keeps its room", () => {
    const columns = layoutColumns(1400, 70)
    expect(columns.graph).toBe(160)
    expect(columns.graph).toBeLessThan(columns.graphNeeds)
  })

  it("drops author, then commit, then date as the pane narrows", () => {
    expect(layoutColumns(700, 3)).toMatchObject({ showAuthor: false, showDate: true, showCommit: true })
    expect(layoutColumns(560, 3)).toMatchObject({ showAuthor: false, showDate: true, showCommit: false })
    expect(layoutColumns(420, 3)).toMatchObject({ showAuthor: false, showDate: false, showCommit: false })
  })
})
