import type { Ref, RefId } from "@/model/model.gen"

/** A ref as shown on a commit row. */
export interface Badge {
  readonly ref: Ref
  /** The checked-out branch of the active worktree. */
  readonly isHead: boolean
  /** A local branch whose upstream points at the same commit; the upstream is not shown separately. */
  readonly inSync: boolean
}

const kindOrder: Record<Ref["kind"], number> = { localBranch: 0, remoteBranch: 1, tag: 2, stash: 3 }

/** The refs that outrank every other on a row. */
export interface BadgeFocus {
  /** The active worktree's checked-out branch. */
  readonly head: RefId | undefined
  readonly emphasized: RefId | undefined
}

/**
 * Orders a row's refs by importance: the checked-out branch, the emphasized
 * ref, other local branches, remote branches (the checked-out branch's
 * upstream first), tags, then stashes. A local branch and its upstream at
 * the same commit become one badge.
 */
export const badgesFor = (
  refIds: ReadonlyArray<RefId>,
  refsById: ReadonlyMap<string, Ref>,
  { head: headRef, emphasized }: BadgeFocus,
): Array<Badge> => {
  const refs = refIds.flatMap((id) => refsById.get(id) ?? [])
  const absorbed = new Set(refs.flatMap((ref) => (ref.kind === "localBranch" && ref.upstreamRefId ? [ref.upstreamRefId] : [])))
  const headUpstream = headRef ? refsById.get(headRef)?.upstreamRefId : undefined
  const rank = (ref: Ref) =>
    ref.id === headRef || ref.id === headUpstream ? -2 : ref.id === emphasized ? -1 : kindOrder[ref.kind]
  return refs
    .filter((ref) => !(ref.kind === "remoteBranch" && absorbed.has(ref.id)))
    .sort((a, b) => rank(a) - rank(b) || a.shortName.localeCompare(b.shortName, undefined, { numeric: true }))
    .map((ref) => ({
      ref,
      isHead: ref.id === headRef,
      inSync: ref.upstreamRefId !== undefined && refIds.includes(ref.upstreamRefId),
    }))
}
