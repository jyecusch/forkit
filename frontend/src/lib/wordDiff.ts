/** A changed span of a line, as [from, to) character offsets. */
export type Range = readonly [number, number]

/** Words, runs of spaces and single punctuation marks: the units compared. */
const tokenPattern = /\w+|\s+|[^\w\s]/g

/** Comparisons past this many token pairs are skipped as too costly. */
const maxCells = 40_000

/**
 * Below this share of unchanged characters, a pair of lines is treated as
 * rewritten rather than edited, and nothing within it is marked.
 */
const minSimilarity = 0.4

/**
 * Finds what changed between a removed line and the added line that
 * replaced it, word by word. Returns the changed ranges of each, or null when
 * the lines are too different for marking the changes to help.
 */
export const wordDiff = (
  before: string,
  after: string,
  ignoreWhitespace = false,
): { before: Array<Range>; after: Array<Range> } | null => {
  const a = before.match(tokenPattern) ?? []
  const b = after.match(tokenPattern) ?? []
  // Ignoring whitespace, any run of spaces matches any other.
  const same = ignoreWhitespace ? (x: string, y: string) => x === y || (!x.trim() && !y.trim()) : (x: string, y: string) => x === y
  if (a.length * b.length > maxCells) return null

  // Longest common subsequence of tokens, filled from the end.
  const width = b.length + 1
  const lengths = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        same(a[i]!, b[j]!) ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
    }
  }

  const changedBefore: Array<Range> = []
  const changedAfter: Array<Range> = []
  let i = 0
  let j = 0
  let at = 0
  let bt = 0
  let kept = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i]!, b[j]!)) {
      kept += a[i]!.length
      at += a[i++]!.length
      bt += b[j++]!.length
    } else if (j < b.length && (i === a.length || lengths[i * width + j + 1]! >= lengths[(i + 1) * width + j]!)) {
      add(changedAfter, bt, (bt += b[j++]!.length))
    } else {
      add(changedBefore, at, (at += a[i++]!.length))
    }
  }

  const longest = Math.max(before.length, after.length)
  if (longest === 0 || kept / longest < minSimilarity) return null
  return { before: changedBefore, after: changedAfter }
}

/** Appends a range, merging it with the last one when they touch. */
const add = (ranges: Array<Range>, from: number, to: number) => {
  const last = ranges[ranges.length - 1]
  if (last && last[1] === from) ranges[ranges.length - 1] = [last[0], to]
  else ranges.push([from, to])
}
