import { describe, expect, it } from "vitest"
import { fromRejection } from "./errors"

describe("fromRejection", () => {
  it("decodes backend error codes into tagged errors", () => {
    const error = fromRejection(
      JSON.stringify({ code: "BranchCheckedOutElsewhere", message: "in use", details: { worktreeId: "w1" } }),
    )
    expect(error).toMatchObject({ _tag: "BranchCheckedOutElsewhereError", details: { worktreeId: "w1" } })
  })

  it("keeps unrecognised rejections as internal errors", () => {
    const error = fromRejection(new Error("boom"))
    expect(error).toMatchObject({ _tag: "BackendError", code: "Internal", message: "boom" })
  })
})
