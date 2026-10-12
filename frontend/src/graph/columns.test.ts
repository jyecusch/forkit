import { describe, expect, it } from "vitest"
import { layoutColumns } from "./columns"

describe("layoutColumns", () => {
  it("fits a narrow graph and keeps every column on a wide pane", () => {
    const columns = layoutColumns(1400, 4)
    expect(columns).toMatchObject({ showAuthor: true, showDate: true, graph: columns.graphNeeds })
  })

  it("caps a wide graph so the description keeps its room", () => {
    const columns = layoutColumns(1000, 80)
    expect(columns.graph).toBeLessThanOrEqual(350)
    expect(columns.graph).toBeLessThan(columns.graphNeeds)
  })

  it("drops author, then date, as the pane narrows", () => {
    expect(layoutColumns(560, 10)).toMatchObject({ showAuthor: false, showDate: true })
    expect(layoutColumns(420, 10)).toMatchObject({ showAuthor: false, showDate: false })
  })
})
