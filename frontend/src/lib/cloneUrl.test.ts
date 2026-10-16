import { describe, expect, it } from "vitest"
import { cloneFolderName } from "./cloneUrl"

describe("cloneFolderName", () => {
  it("names a clone after the repository", () => {
    expect(cloneFolderName("https://github.com/jyecusch/forkit.git")).toBe("forkit")
    expect(cloneFolderName("https://github.com/jyecusch/forkit/")).toBe("forkit")
    expect(cloneFolderName("git@github.com:jyecusch/forkit.git")).toBe("forkit")
    expect(cloneFolderName("ssh://git@host:2222/team/app.git")).toBe("app")
    expect(cloneFolderName("  /Users/ada/code/app  ")).toBe("app")
  })

  it("has no name for a URL without a path", () => {
    expect(cloneFolderName("")).toBe("")
    expect(cloneFolderName("https://github.com")).toBe("")
    expect(cloneFolderName("https://host:8080/")).toBe("")
  })
})
