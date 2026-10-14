import { describe, expect, it } from "vitest"
import type { Ref, TagOrder } from "@/model/model.gen"
import { parseVersion, tagComparator } from "./tagOrder"

const tag = (name: string, date?: number) => ({ name, ref: { shortName: name, ...(date !== undefined && { date }) } as Ref })
const sorted = (order: TagOrder, tags: ReturnType<typeof tag>[]) => [...tags].sort(tagComparator(order)).map((t) => t.name)

describe("parseVersion", () => {
  it("reads loose versions", () => {
    expect(parseVersion("v2")).toEqual({ prefix: "", core: [2, 0, 0], prerelease: [] })
    expect(parseVersion("app-v1.2.0-rc.1+build.5")).toEqual({ prefix: "app-", core: [1, 2, 0], prerelease: ["rc", 1] })
    expect(parseVersion("pkg@0.3.1")?.prefix).toBe("pkg@")
  })

  it("rejects names that are not versions", () => {
    expect(parseVersion("latest")).toBeUndefined()
    expect(parseVersion("1.2.3.4")).toBeUndefined()
  })
})

describe("tagComparator", () => {
  it("puts newer versions first, releases above their pre-releases", () => {
    const tags = ["v1.0.0", "v1.10.0", "v1.2.0", "v2.0.0-rc.2", "v2.0.0", "v2.0.0-rc.10", "v2.0.0-beta", "v0.9"].map((name) => tag(name))
    expect(sorted("version", tags)).toEqual(["v2.0.0", "v2.0.0-rc.10", "v2.0.0-rc.2", "v2.0.0-beta", "v1.10.0", "v1.2.0", "v1.0.0", "v0.9"])
  })

  it("groups versions by prefix and puts other tags after them, newest first", () => {
    const tags = [tag("old-name", 1), tag("lib-1.0.0"), tag("app-2.0.0"), tag("new-name", 2), tag("app-10.0.0")]
    expect(sorted("version", tags)).toEqual(["app-10.0.0", "app-2.0.0", "lib-1.0.0", "new-name", "old-name"])
  })

  it("orders by date or by name when asked", () => {
    const tags = [tag("b", 1), tag("a", 3), tag("c", 2)]
    expect(sorted("date", tags)).toEqual(["a", "c", "b"])
    expect(sorted("name", tags)).toEqual(["a", "b", "c"])
  })
})
