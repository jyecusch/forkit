import { describe, expect, it } from "vitest"
import { mixHex } from "./draw"

describe("mixHex", () => {
  it("blends towards the second colour as the weight falls", () => {
    expect(mixHex("#ffffff", "#000000", 1)).toBe("#ffffff")
    expect(mixHex("#ffffff", "#000000", 0)).toBe("#000000")
    expect(mixHex("#7aa2f7", "#1a1b26", 0.5)).toBe("#4a5f8f")
  })
})
