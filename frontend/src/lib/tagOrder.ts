import type { Ref, TagOrder } from "@/model/model.gen"

/**
 * A tag read as a semantic version. Tags are often written loosely, so a
 * "v", missing minor and patch numbers ("v2" is 2.0.0) and a prefix naming
 * what is released ("app-1.2.0", "pkg@1.2.0") are allowed.
 */
export interface Version {
  readonly prefix: string
  readonly core: readonly [number, number, number]
  /** Pre-release identifiers, such as ["rc", 1] for "-rc.1"; empty for a release. */
  readonly prerelease: ReadonlyArray<string | number>
}

// The prefix cannot end in a digit or dot, so "1.2.3.4" is not read as
// "1." and 2.3.4, nor in "v", which belongs to the version.
const versionPattern = /^(?<prefix>(?:.*[^\d.vV])?)[vV]?(?<core>\d+(?:\.\d+){0,2})(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export const parseVersion = (name: string): Version | undefined => {
  const match = versionPattern.exec(name)
  if (!match?.groups) return undefined
  const [major = 0, minor = 0, patch = 0] = match.groups["core"]!.split(".").map(Number)
  const pre = match.groups["pre"]
  return {
    prefix: match.groups["prefix"]!,
    core: [major, minor, patch],
    prerelease: pre ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  }
}

/** Semantic version precedence, ignoring the prefix: negative when a comes before b. */
export const compareVersions = (a: Version, b: Version): number => {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!
  }
  // A release outranks its pre-releases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const [x, y] = [a.prerelease[i]!, b.prerelease[i]!]
    if (x === y) continue
    if (typeof x === "number" && typeof y === "number") return x - y
    // Numbers rank below words.
    if (typeof x === "number") return -1
    if (typeof y === "number") return 1
    return x < y ? -1 : 1
  }
  return a.prerelease.length - b.prerelease.length
}

/** Orders names the way people expect, with fix-9 before fix-10. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

/** Newest first; refs without a date go last. */
const byDate = (a: Ref, b: Ref) => (b.date ?? -Infinity) - (a.date ?? -Infinity)

export interface NamedTag {
  /** The tag's name within its folder in the sidebar. */
  readonly name: string
  readonly ref: Ref
}

/**
 * Compares tags for the sidebar. By version, versions come first, grouped by
 * prefix and newest first, then every other tag, newest first. By date,
 * newest first. Ties fall back to the name.
 */
export const tagComparator = (order: TagOrder) => {
  if (order === "name") return (a: NamedTag, b: NamedTag) => byName(a.name, b.name)
  if (order === "date") return (a: NamedTag, b: NamedTag) => byDate(a.ref, b.ref) || byName(a.name, b.name)
  const versions = new Map<string, Version | undefined>()
  const versionOf = (name: string) => {
    if (!versions.has(name)) versions.set(name, parseVersion(name))
    return versions.get(name)
  }
  return (a: NamedTag, b: NamedTag) => {
    const [va, vb] = [versionOf(a.name), versionOf(b.name)]
    if (va && vb) return byName(va.prefix, vb.prefix) || compareVersions(vb, va) || byName(a.name, b.name)
    if (va || vb) return va ? -1 : 1
    return byDate(a.ref, b.ref) || byName(a.name, b.name)
  }
}
