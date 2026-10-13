import { gutter, laneWidth } from "./geometry"

/** Horizontal inset of the commit list's content, each side. */
export const listInset = 12
/** Space between columns. */
export const columnGap = 12
const gap = columnGap
/** The branch and tag column's share of the pane, within its limits. */
const refsShare = 0.14
const minRefs = 120
const maxRefs = 200
const commitWidth = 64
const dateWidth = 96
const authorWidth = 104
const minDescription = 280
const maxGraph = 160
/** The graph's share of a wide pane, when that is more than maxGraph. */
const graphShare = 0.25
/** Lanes the graph keeps before optional columns are dropped for it. */
const comfortableLanes = 3

/** Widths the user has given columns; any left out are chosen automatically. */
export interface ColumnSizes {
  readonly refs?: number | undefined
  readonly graph?: number | undefined
  readonly author?: number | undefined
  readonly date?: number | undefined
  readonly commit?: number | undefined
}

export interface Columns {
  /** Width of the branch and tag column, left of the graph. */
  readonly refs: number
  /** Where the graph column starts, from the list's left edge. */
  readonly graphLeft: number
  /** Width of the graph column; lanes beyond it are reached by panning. */
  readonly graph: number
  /** Width the graph would need to show every lane on screen. */
  readonly graphNeeds: number
  readonly showAuthor: boolean
  readonly showDate: boolean
  readonly showCommit: boolean
  readonly author: number
  readonly date: number
  readonly commit: number
  /** CSS grid-template-columns for the header and every row. */
  readonly template: string
}

/** The graph width that shows lanes 0..widestLane. */
const graphWidthFor = (widestLane: number) => gutter * 2 + Math.max(widestLane, 0) * laneWidth

/**
 * Sizes the commit list's columns for a graph of the given lanes. Branch and
 * tag labels come first, then the graph. The description always keeps at
 * least minDescription, and the graph a few lanes; author, then commit, then
 * date make way for them on narrow panes. The graph then takes what its
 * lanes need, up to a quarter of the pane, unless the user has sized it.
 */
export const layoutColumns = (paneWidth: number, lanes: number, sizes: ColumnSizes = {}): Columns => {
  const refs = sizes.refs ?? Math.round(Math.min(Math.max(paneWidth * refsShare, minRefs), maxRefs))
  const author = sizes.author ?? authorWidth
  const date = sizes.date ?? dateWidth
  const commit = sizes.commit ?? commitWidth
  const graphNeeds = graphWidthFor(lanes - 1)
  const minGraph = Math.min(graphNeeds, graphWidthFor(comfortableLanes - 1))
  const choices = [
    { showAuthor: true, showDate: true, showCommit: true },
    { showAuthor: false, showDate: true, showCommit: true },
    { showAuthor: false, showDate: true, showCommit: false },
    { showAuthor: false, showDate: false, showCommit: false },
  ]
  type Choice = (typeof choices)[number]
  const optional = (c: Choice) =>
    [c.showAuthor && author, c.showDate && date, c.showCommit && commit].filter((w): w is number => typeof w === "number")
  const fixedWidth = (c: Choice) => listInset * 2 + refs + gap + optional(c).reduce((sum, w) => sum + w + gap, gap)
  const choice = choices.find((c) => paneWidth - fixedWidth(c) >= minDescription + minGraph) ?? choices[choices.length - 1]!
  const budget = Math.min(Math.max(maxGraph, Math.round(paneWidth * graphShare)), paneWidth - fixedWidth(choice) - minDescription)
  // A graph narrower than it needs ends on a whole lane.
  const automatic = graphNeeds <= budget ? graphNeeds : graphWidthFor(Math.floor((budget - gutter * 2) / laneWidth))
  const room = paneWidth - fixedWidth(choice) - minDescription
  const graph = Math.max(graphWidthFor(1), sizes.graph === undefined ? automatic : Math.min(sizes.graph, room))
  const template = [`${refs}px`, `${graph}px`, "minmax(0,1fr)", ...optional(choice).map((w) => `${w}px`)].join(" ")
  return { refs, graphLeft: listInset + refs + gap, graph, graphNeeds, ...choice, author, date, commit, template }
}
