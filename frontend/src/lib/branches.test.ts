import { describe, expect, it } from "vitest"
import type { Ref } from "@/model/model.gen"
import { branchFamily } from "./branches"

const ref = (id: string, kind: Ref["kind"], upstreamRefId?: string) =>
  ({ id, kind, shortName: id, ...(upstreamRefId && { upstreamRefId }) }) as unknown as Ref
const refs = [
  ref("topic", "localBranch", "origin/topic"),
  ref("origin/topic", "remoteBranch"),
  ref("fork/topic", "remoteBranch"),
  ref("origin/other", "remoteBranch"),
  ref("renamed", "localBranch", "origin/upstream-name"),
  ref("origin/upstream-name", "remoteBranch"),
  ref("v1", "tag"),
]
const byId = new Map<string, Ref>(refs.map((r) => [r.id, r]))
const familyOf = (id: string) => branchFamily(byId.get(id)!, refs).map((r) => r.id)

describe("branchFamily", () => {
  it("gathers a local branch and its namesakes on every remote", () => {
    expect(familyOf("topic")).toEqual(["topic", "fork/topic", "origin/topic"])
    expect(familyOf("fork/topic")).toEqual(["topic", "fork/topic", "origin/topic"])
  })

  it("follows an upstream with a different name", () => {
    expect(familyOf("renamed")).toEqual(["renamed", "origin/upstream-name"])
    expect(familyOf("origin/upstream-name")).toEqual(["renamed", "origin/upstream-name"])
  })

  it("leaves out the local branch when there is none", () => {
    expect(familyOf("origin/other")).toEqual(["origin/other"])
  })

  it("offers nothing for tags", () => {
    expect(familyOf("v1")).toEqual([])
  })
})
