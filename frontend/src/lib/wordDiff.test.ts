import { describe, expect, it } from "vitest"
import { wordDiff } from "./wordDiff"

const marked = (text: string, ranges: ReadonlyArray<readonly [number, number]>) => ranges.map(([from, to]) => text.slice(from, to))

describe("wordDiff", () => {
  it("marks only the words that changed", () => {
    const before = "const timeout = 30_000 // ms"
    const after = "const timeout = 60_000 // ms"
    const diff = wordDiff(before, after)!
    expect(marked(before, diff.before)).toEqual(["30_000"])
    expect(marked(after, diff.after)).toEqual(["60_000"])
  })

  it("marks insertions on one side only", () => {
    const diff = wordDiff("call(a, b)", "call(a, b, c)")!
    expect(diff.before).toEqual([])
    expect(marked("call(a, b, c)", diff.after)).toEqual([", c"])
  })

  it("can treat any spacing as the same", () => {
    const diff = wordDiff("if (a  &&  b) {", "if (a && c) {", true)!
    expect(marked("if (a && c) {", diff.after)).toEqual(["c"])
  })

  it("leaves lines that were rewritten unmarked", () => {
    expect(wordDiff("return cache.get(key)", "throw new Error(message)")).toBeNull()
  })
})
