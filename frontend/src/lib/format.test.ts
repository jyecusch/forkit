import { describe, expect, it } from "vitest"
import { baseName, formatDate, initials } from "./format"

describe("formatDate", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0)
  it("describes recent times relatively", () => {
    expect(formatDate(now - 12 * 60_000, "relative", now)).toMatch(/12 minutes ago/)
    expect(formatDate(now - 10_000, "relative", now)).toBe("just now")
  })
  it("formats ISO dates without seconds", () => {
    expect(formatDate(now, "iso", now)).toBe("2026-10-12 12:00")
  })
})

describe("names and paths", () => {
  it("takes initials and base names", () => {
    expect(initials("Priya Nair")).toBe("PN")
    expect(baseName("/home/ada/repos/forkit/")).toBe("forkit")
    expect(baseName("C:\\code\\forkit")).toBe("forkit")
  })
})
