import type { Ref, RefId, Remote, TagOrder, Worktree } from "@/model/model.gen"
import { baseName } from "./format"
import { tagComparator } from "./tagOrder"

/** One line of the sidebar navigator. */
export type NavRow =
  | { readonly type: "section"; readonly id: SectionId; readonly title: string; readonly count: number; readonly collapsed: boolean }
  | { readonly type: "worktree"; readonly id: string; readonly worktree: Worktree; readonly name: string }
  | { readonly type: "remote"; readonly id: string; readonly remote: Remote; readonly count: number; readonly collapsed: boolean }
  | { readonly type: "folder"; readonly id: string; readonly name: string; readonly depth: number; readonly collapsed: boolean }
  | { readonly type: "ref"; readonly id: string; readonly name: string; readonly depth: number; readonly ref: Ref }

export type SectionId = "worktrees" | "branches" | "remotes" | "tags" | "stashes"

export interface NavInput {
  readonly refs: ReadonlyArray<Ref>
  readonly remotes: ReadonlyArray<Remote>
  readonly worktrees: ReadonlyArray<Worktree>
  /** Node IDs open by default because they hold a ref worth showing; see revealedNodes. */
  readonly revealed: ReadonlySet<string>
  /** Node IDs the user opened (true) or closed (false), which beat every default. */
  readonly choices: ReadonlyMap<string, boolean>
  readonly filter: string
  readonly tagOrder: TagOrder
}

/** Orders names the way people expect, with fix-9 before fix-10. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

type Entry = { readonly name: string; readonly ref: Ref }

const entriesByName = (a: Entry, b: Entry) => byName(a.name, b.name)

/**
 * Flattens a repository into navigator rows: worktrees, local branches,
 * remotes (each holding its branches), tags and stashes, with "/"-separated
 * names nested as folders. While filtering, every match is shown.
 */
export const buildNavRows = ({ refs, remotes, worktrees, revealed, choices, filter, tagOrder }: NavInput): Array<NavRow> => {
  const query = filter.trim().toLowerCase()
  const matches = (text: string) => query === "" || text.toLowerCase().includes(query)
  const isCollapsed = (id: string, byDefault: boolean) => {
    const choice = choices.get(id)
    if (choice !== undefined) return !choice
    return query === "" && !revealed.has(id) && byDefault
  }

  const rows: Array<NavRow> = []
  const section = (id: SectionId, title: string, count: number, byDefault: boolean, fill: () => void) => {
    if (count === 0) return
    const collapsed = isCollapsed(id, byDefault)
    rows.push({ type: "section", id, title, count, collapsed })
    if (!collapsed) fill()
  }

  const shownWorktrees = worktrees
    .filter((wt) => matches(baseName(wt.path)) || matches(branchOf(wt, refs)))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || byName(baseName(a.path), baseName(b.path)))
  section("worktrees", "Worktrees", shownWorktrees.length, false, () => {
    for (const worktree of shownWorktrees) rows.push({ type: "worktree", id: worktree.id, worktree, name: baseName(worktree.path) })
  })

  const ofKind = (kind: Ref["kind"]) => refs.filter((ref) => ref.kind === kind && matches(ref.shortName))
  const branches = ofKind("localBranch")
  section("branches", "Branches", branches.length, false, () =>
    appendTree(rows, "branches", branches.map((ref) => ({ name: ref.shortName, ref })), 0, (id) => isCollapsed(id, false), entriesByName),
  )

  const remoteBranches = ofKind("remoteBranch")
  const orderedRemotes = [...remotes].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin") || byName(a.name, b.name))
  const branchesOf = (remote: Remote) =>
    remoteBranches.filter((ref) => ref.remoteId === remote.id).map((ref) => ({ name: ref.shortName.slice(remote.name.length + 1), ref }))
  const shownRemotes = orderedRemotes.filter((remote) => query === "" || branchesOf(remote).length > 0)
  section("remotes", "Remotes", shownRemotes.length, false, () => {
    for (const remote of shownRemotes) {
      const id = `remote:${remote.name}`
      const entries = branchesOf(remote)
      const collapsed = isCollapsed(id, true)
      rows.push({ type: "remote", id, remote, count: entries.length, collapsed })
      if (!collapsed) appendTree(rows, id, entries, 1, (folder) => isCollapsed(folder, true), entriesByName)
    }
  })

  const tags = ofKind("tag")
  section("tags", "Tags", tags.length, true, () =>
    appendTree(rows, "tags", tags.map((ref) => ({ name: ref.shortName, ref })), 0, (id) => isCollapsed(id, true), tagComparator(tagOrder)),
  )

  const stashes = ofKind("stash")
  section("stashes", "Stashes", stashes.length, true, () => {
    for (const ref of stashes) rows.push({ type: "ref", id: ref.id, name: ref.shortName, depth: 0, ref })
  })
  return rows
}

const branchOf = (worktree: Worktree, refs: ReadonlyArray<Ref>) =>
  refs.find((ref) => ref.id === worktree.head.refId)?.shortName ?? ""

/** The IDs of every section, remote and folder that contains one of the given refs. */
export const revealedNodes = (refs: ReadonlyArray<Ref>, remotes: ReadonlyArray<Remote>, reveal: ReadonlyArray<RefId>): Set<string> => {
  const nodes = new Set<string>()
  for (const ref of refs) {
    if (!reveal.includes(ref.id)) continue
    let parent: string
    let name = ref.shortName
    switch (ref.kind) {
      case "localBranch":
        parent = "branches"
        break
      case "remoteBranch": {
        const remote = remotes.find((r) => r.id === ref.remoteId)
        if (!remote) continue
        nodes.add("remotes")
        parent = `remote:${remote.name}`
        name = ref.shortName.slice(remote.name.length + 1)
        break
      }
      case "tag":
        parent = "tags"
        break
      default:
        parent = "stashes"
    }
    nodes.add(parent)
    const parts = name.split("/").slice(0, -1)
    for (const part of parts) {
      parent = `${parent}/${part}`
      nodes.add(parent)
    }
  }
  return nodes
}

const appendTree = (
  rows: Array<NavRow>,
  parentId: string,
  entries: ReadonlyArray<Entry>,
  depth: number,
  isCollapsed: (id: string) => boolean,
  /** Orders refs within each folder; folders themselves go by name. */
  compare: (a: Entry, b: Entry) => number,
) => {
  const folders = new Map<string, Array<Entry>>()
  const leaves: Array<Entry> = []
  for (const entry of entries) {
    const slash = entry.name.indexOf("/")
    if (slash < 0) {
      leaves.push(entry)
      continue
    }
    const folder = entry.name.slice(0, slash)
    const children = folders.get(folder) ?? []
    children.push({ name: entry.name.slice(slash + 1), ref: entry.ref })
    folders.set(folder, children)
  }
  for (const [name, children] of [...folders].sort(([a], [b]) => byName(a, b))) {
    const id = `${parentId}/${name}`
    const collapsed = isCollapsed(id)
    rows.push({ type: "folder", id, name, depth, collapsed })
    if (!collapsed) {
      appendTree(rows, id, children, depth + 1, isCollapsed, compare)
    }
  }
  for (const leaf of leaves.sort(compare)) {
    rows.push({ type: "ref", id: leaf.ref.id, name: leaf.name, depth, ref: leaf.ref })
  }
}
