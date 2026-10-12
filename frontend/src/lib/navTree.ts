import type { Ref, Remote } from "@/model/model.gen"

/** One line of the reference navigator. */
export type NavRow =
  | { readonly type: "section"; readonly id: string; readonly title: string; readonly count: number; readonly collapsed: boolean }
  | { readonly type: "folder"; readonly id: string; readonly name: string; readonly depth: number; readonly collapsed: boolean }
  | { readonly type: "ref"; readonly id: string; readonly name: string; readonly depth: number; readonly ref: Ref }

interface Group {
  readonly id: string
  readonly title: string
  readonly refs: ReadonlyArray<{ readonly name: string; readonly ref: Ref }>
}

/** Whether a node starts collapsed before the user toggles it. */
const collapsedByDefault = (id: string) => id === "tags" || id.includes("/")

/**
 * Flattens refs into navigator rows: sections for local branches, each
 * remote, tags and stashes, with "/"-separated names nested as folders.
 * toggled holds the IDs the user expanded or collapsed. While filtering,
 * every match is shown.
 */
export const buildNavRows = (
  refs: ReadonlyArray<Ref>,
  remotes: ReadonlyArray<Remote>,
  toggled: ReadonlySet<string>,
  filter: string,
): Array<NavRow> => {
  const query = filter.trim().toLowerCase()
  const matches = (ref: Ref) => query === "" || ref.shortName.toLowerCase().includes(query)
  const isCollapsed = (id: string) => query === "" && collapsedByDefault(id) !== toggled.has(id)

  const byKind = (kind: Ref["kind"]) => refs.filter((ref) => ref.kind === kind && matches(ref))
  const groups: Array<Group> = [
    { id: "local", title: "Local branches", refs: byKind("localBranch").map((ref) => ({ name: ref.shortName, ref })) },
    ...remotes.map((remote) => ({
      id: `remote:${remote.name}`,
      title: remote.name,
      refs: byKind("remoteBranch")
        .filter((ref) => ref.remoteId === remote.id)
        .map((ref) => ({ name: ref.shortName.slice(remote.name.length + 1), ref })),
    })),
    { id: "tags", title: "Tags", refs: byKind("tag").map((ref) => ({ name: ref.shortName, ref })) },
    { id: "stashes", title: "Stashes", refs: byKind("stash").map((ref) => ({ name: ref.shortName, ref })) },
  ]

  const rows: Array<NavRow> = []
  for (const group of groups) {
    if (group.refs.length === 0) {
      continue
    }
    const collapsed = isCollapsed(group.id)
    rows.push({ type: "section", id: group.id, title: group.title, count: group.refs.length, collapsed })
    if (!collapsed) {
      appendTree(rows, group.id, group.refs, 0, isCollapsed)
    }
  }
  return rows
}

/** Orders names the way people expect, with fix-9 before fix-10. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

const appendTree = (
  rows: Array<NavRow>,
  parentId: string,
  entries: ReadonlyArray<{ readonly name: string; readonly ref: Ref }>,
  depth: number,
  isCollapsed: (id: string) => boolean,
) => {
  const folders = new Map<string, Array<{ name: string; ref: Ref }>>()
  const leaves: Array<{ name: string; ref: Ref }> = []
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
      appendTree(rows, id, children, depth + 1, isCollapsed)
    }
  }
  for (const leaf of leaves.sort((a, b) => byName(a.name, b.name))) {
    rows.push({ type: "ref", id: leaf.ref.id, name: leaf.name, depth, ref: leaf.ref })
  }
}
