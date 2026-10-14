import type { Ref, RefId } from "@/model/model.gen"

/** A ref as shown on a commit row. */
export interface Badge {
  readonly ref: Ref
  /** The checked-out branch of the active worktree. */
  readonly isHead: boolean
  /** The ref whose history is drawn at full strength. */
  readonly isEmphasized: boolean
  /** A local branch whose upstream points at the same commit; the upstream is not shown separately. */
  readonly inSync: boolean
  /** Same-named remote branches folded into this badge, whether it is a local or a remote branch. */
  readonly sameOnOtherRemotes: ReadonlyArray<Ref>
}

/** A remote branch's name without its remote, such as main for origin/main. */
export const remoteBranchName = (ref: Ref) => ref.shortName.slice(ref.shortName.indexOf("/") + 1)

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
 * upstream first), then tags. Stashes are rows of their own and get no
 * badge. A local branch and its upstream at
 * the same commit become one badge, as do same-named branches on several
 * remotes.
 */
export const badgesFor = (
  refIds: ReadonlyArray<RefId>,
  refsById: ReadonlyMap<string, Ref>,
  { head: headRef, emphasized }: BadgeFocus,
): Array<Badge> => {
  const refs = refIds.flatMap((id) => refsById.get(id) ?? []).filter((ref) => ref.kind !== "stash")
  const absorbed = new Set(refs.flatMap((ref) => (ref.kind === "localBranch" && ref.upstreamRefId ? [ref.upstreamRefId] : [])))
  const headUpstream = headRef ? refsById.get(headRef)?.upstreamRefId : undefined
  const rank = (ref: Ref) =>
    ref.id === headRef || ref.id === headUpstream ? -2 : ref.id === emphasized ? -1 : kindOrder[ref.kind]
  const badges: Array<Badge & { sameOnOtherRemotes: Array<Ref> }> = []
  // Remote branches fold into a same-named branch shown before them, local or remote.
  const byName = new Map<string, { sameOnOtherRemotes: Array<Ref> }>()
  const ordered = refs
    .filter((ref) => !(ref.kind === "remoteBranch" && absorbed.has(ref.id)))
    .sort((a, b) => rank(a) - rank(b) || a.shortName.localeCompare(b.shortName, undefined, { numeric: true }))
  for (const ref of ordered) {
    const same = ref.kind === "remoteBranch" && ref.id !== emphasized ? byName.get(remoteBranchName(ref)) : undefined
    if (same) {
      same.sameOnOtherRemotes.push(ref)
      continue
    }
    const badge = {
      ref,
      isHead: ref.id === headRef,
      isEmphasized: ref.id === emphasized,
      inSync: ref.upstreamRefId !== undefined && refIds.includes(ref.upstreamRefId),
      sameOnOtherRemotes: [],
    }
    if (ref.kind === "localBranch" && !byName.has(ref.shortName)) byName.set(ref.shortName, badge)
    if (ref.kind === "remoteBranch" && !badge.isEmphasized) byName.set(remoteBranchName(ref), badge)
    badges.push(badge)
  }
  return badges
}
