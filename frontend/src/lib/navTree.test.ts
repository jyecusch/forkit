import { describe, expect, it } from "vitest"
import type { Ref, Remote } from "@/model/model.gen"
import { buildNavRows, type NavRow } from "./navTree"

const ref = (kind: Ref["kind"], shortName: string, remoteId?: string) =>
  ({ id: `r:${kind}:${shortName}`, kind, shortName, ...(remoteId && { remoteId }) }) as unknown as Ref
const origin = { id: "r:origin", name: "origin" } as unknown as Remote

const describeRows = (rows: Array<NavRow>) =>
  rows.map((row) => {
    switch (row.type) {
      case "section":
        return `${row.title} (${row.count})${row.collapsed ? " +" : ""}`
      case "folder":
        return `${"  ".repeat(row.depth + 1)}${row.name}/${row.collapsed ? " +" : ""}`
      case "ref":
        return `${"  ".repeat(row.depth + 1)}${row.name}`
    }
  })

const refs = [
  ref("localBranch", "main"),
  ref("localBranch", "feature/tabs"),
  ref("remoteBranch", "origin/main", "r:origin"),
  ref("remoteBranch", "origin/fix/crlf", "r:origin"),
  ref("tag", "v1.0"),
]

describe("buildNavRows", () => {
  it("groups refs into sections with folders collapsed", () => {
    expect(describeRows(buildNavRows(refs, [origin], new Set(), ""))).toEqual([
      "Local branches (2)",
      "  feature/ +",
      "  main",
      "origin (2)",
      "  fix/ +",
      "  main",
      "Tags (1) +",
    ])
  })

  it("expands what the user toggled", () => {
    const rows = buildNavRows(refs, [origin], new Set(["local/feature", "tags"]), "")
    expect(describeRows(rows)).toContain("    tabs")
    expect(describeRows(rows)).toContain("  v1.0")
  })

  it("shows every match while filtering", () => {
    expect(describeRows(buildNavRows(refs, [origin], new Set(), "crlf"))).toEqual(["origin (1)", "  fix/", "    crlf"])
  })
})
