import { describe, expect, it } from "vitest"
import type { Ref, RefId } from "@/model/model.gen"
import { badgesFor } from "./badges"

const ref = (id: string, kind: Ref["kind"], upstreamRefId?: string) =>
  ({ id, kind, shortName: id, ...(upstreamRefId && { upstreamRefId }) }) as unknown as Ref
const refs = [
  ref("v1", "tag"),
  ref("fork/main", "remoteBranch"),
  ref("origin/main", "remoteBranch"),
  ref("topic", "localBranch"),
  ref("main", "localBranch", "origin/main"),
]
const byId = new Map<string, Ref>(refs.map((r) => [r.id, r]))
const ids = refs.map((r) => r.id as RefId)

describe("badgesFor", () => {
  it("puts the checked-out branch first and folds in its upstream at the same commit", () => {
    const badges = badgesFor(ids, byId, "main" as RefId)
    expect(badges.map((b) => b.ref.id)).toEqual(["main", "topic", "fork/main", "v1"])
    expect(badges[0]).toMatchObject({ isHead: true, inSync: true })
  })

  it("keeps an upstream that is on a different commit", () => {
    const badges = badgesFor(["main" as RefId], byId, undefined)
    expect(badges).toEqual([{ ref: byId.get("main"), isHead: false, inSync: false }])
  })
})
