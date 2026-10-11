import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GraphRow, Ref } from "./model.gen"

describe("generated schemas", () => {
  it("decode arrays that Go omitted as empty", () => {
    const row = Schema.decodeUnknownSync(GraphRow)({ index: 0, oid: "abc", lane: 0, threadId: 0, onEmphasized: false })
    expect(row.edges).toEqual([])
    expect(row.refIds).toEqual([])
  })

  it("leave omitted optional fields absent", () => {
    const ref = Schema.decodeUnknownSync(Ref)({
      id: "r:refs/heads/main",
      repoId: "r",
      fullName: "refs/heads/main",
      shortName: "main",
      kind: "localBranch",
      targetOid: "abc",
    })
    expect("upstreamRefId" in ref).toBe(false)
  })
})
