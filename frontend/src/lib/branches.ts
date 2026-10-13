import type { Ref } from "@/model/model.gen"
import { remoteBranchName } from "./badges"

/**
 * The branches offered for deletion alongside ref: the local branch (ref
 * itself, the one tracking it, or one of the same name), then its upstream
 * and same-named branches on every remote. Empty for tags and stashes.
 */
export const branchFamily = (ref: Ref, refs: ReadonlyArray<Ref>): Array<Ref> => {
  if (ref.kind !== "localBranch" && ref.kind !== "remoteBranch") return []
  const locals = refs.filter((r) => r.kind === "localBranch")
  const local =
    ref.kind === "localBranch"
      ? ref
      : (locals.find((r) => r.upstreamRefId === ref.id) ?? locals.find((r) => r.shortName === remoteBranchName(ref)))
  const name = local?.shortName ?? remoteBranchName(ref)
  const remotes = refs
    .filter((r) => r.kind === "remoteBranch" && (r.id === ref.id || r.id === local?.upstreamRefId || remoteBranchName(r) === name))
    .sort((a, b) => a.shortName.localeCompare(b.shortName))
  return local ? [local, ...remotes] : remotes
}
