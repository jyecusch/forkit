import { describe, expect, it } from "vitest"
import { baseName, formatDate, initials, reflow } from "./format"

describe("formatDate", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0)
  it("describes recent times relatively", () => {
    expect(formatDate(now - 12 * 60_000, "relative", now)).toMatch(/12 minutes ago/)
    expect(formatDate(now - 10_000, "relative", now)).toBe("just now")
  })
  it("formats ISO dates in local time without seconds", () => {
    const local = new Date(2026, 9, 12, 9, 5).getTime()
    expect(formatDate(local, "iso", now)).toBe("2026-10-12 09:05")
  })

  it("treats times in the future as just now", () => {
    expect(formatDate(now + 2 * 86_400_000, "relative", now)).toBe("just now")
  })
})

describe("names and paths", () => {
  it("takes initials and base names", () => {
    expect(initials("Priya Nair")).toBe("PN")
    expect(baseName("/home/ada/repos/forkit/")).toBe("forkit")
    expect(baseName("C:\\code\\forkit")).toBe("forkit")
  })
})

describe("reflow", () => {
  it("joins wrapped lines into paragraphs and keeps blank lines", () => {
    expect(reflow("one two\nthree\n\nfour\nfive")).toBe("one two three\n\nfour five")
  })

  it("keeps list items, their wrapped text joined, and code as written", () => {
    const message = ["- first item", "  continues", "- second", "wraps here", "", "```", "a", "b", "```", "    indented", "    code"].join("\n")
    expect(reflow(message)).toBe(["- first item", "  continues", "- second wraps here", "", "```", "a", "b", "```", "    indented", "    code"].join("\n"))
  })
})
