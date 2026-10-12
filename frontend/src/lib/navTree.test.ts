import { describe, expect, it } from "vitest"
import type { Ref, RefId, Remote, Worktree } from "@/model/model.gen"
import { buildNavRows, type NavInput, type NavRow } from "./navTree"

const ref = (kind: Ref["kind"], shortName: string, remoteId?: string) =>
  ({ id: `r:${kind}:${shortName}`, kind, shortName, ...(remoteId && { remoteId }) }) as unknown as Ref
const remote = (name: string) => ({ id: `r:${name}`, name }) as unknown as Remote
const worktree = (path: string, isMain: boolean, branch: string) =>
  ({ id: path, path, isMain, head: { kind: "branch", refId: `r:localBranch:${branch}` } }) as unknown as Worktree

const describeRows = (rows: Array<NavRow>) =>
  rows.map((row) => {
    switch (row.type) {
      case "section":
        return `${row.title}${row.collapsed ? " +" : ""}`
      case "worktree":
        return `  [${row.name}]`
      case "remote":
        return `  @${row.remote.name} (${row.count})${row.collapsed ? " +" : ""}`
      case "folder":
        return `${"  ".repeat(row.depth + 1)}${row.name}/${row.collapsed ? " +" : ""}`
      case "ref":
        return `${"  ".repeat(row.depth + 1)}${row.name}`
    }
  })

const input = (overrides: Partial<NavInput> = {}): NavInput => ({
  refs: [
    ref("localBranch", "main"),
    ref("localBranch", "feature/tabs"),
    ref("remoteBranch", "origin/main", "r:origin"),
    ref("remoteBranch", "fork/fix/crlf", "r:fork"),
    ref("tag", "v1.0"),
  ],
  remotes: [remote("fork"), remote("origin")],
  worktrees: [worktree("/w/app-tabs", false, "feature/tabs"), worktree("/w/app", true, "main")],
  reveal: [],
  toggled: new Set(),
  filter: "",
  ...overrides,
})

describe("buildNavRows", () => {
  it("lists worktrees, open local branches, remotes with origin first, and closed tags", () => {
    expect(describeRows(buildNavRows(input()))).toEqual([
      "Worktrees",
      "  [app]",
      "  [app-tabs]",
      "Branches",
      "  feature/",
      "    tabs",
      "  main",
      "Remotes",
      "  @origin (1) +",
      "  @fork (1) +",
      "Tags +",
    ])
  })

  it("opens the remote and folders holding a revealed ref", () => {
    const rows = describeRows(buildNavRows(input({ reveal: ["r:remoteBranch:fork/fix/crlf" as RefId] })))
    expect(rows).toContain("  @fork (1)")
    expect(rows).toContain("    fix/")
    expect(rows).toContain("      crlf")
  })

  it("shows every match while filtering", () => {
    expect(describeRows(buildNavRows(input({ filter: "crlf" })))).toEqual(["Remotes", "  @fork (1)", "    fix/", "      crlf"])
  })
})
