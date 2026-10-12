import { gutter, laneWidth } from "./geometry"

/** Horizontal inset of the commit list's content, each side. */
export const listInset = 12
const gap = 12
const commitWidth = 64
const dateWidth = 96
const authorWidth = 136
const minDescription = 320
const minGraph = 48
const maxGraph = 160

export interface Columns {
  /** Width of the graph column; lanes beyond it are reached by panning. */
  readonly graph: number
  /** Width the graph would need to show every lane on screen. */
  readonly graphNeeds: number
  readonly showAuthor: boolean
  readonly showDate: boolean
  readonly showCommit: boolean
  /** CSS grid-template-columns for the header and every row. */
  readonly template: string
}

/** The graph width that shows lanes 0..widestLane. */
export const graphWidthFor = (widestLane: number) => gutter * 2 + Math.max(widestLane, 0) * laneWidth

/**
 * Sizes the commit list's columns. The description always keeps at least
 * minDescription; author, then commit, then date make way for it on narrow
 * panes. The graph takes what the lanes on screen need, up to maxGraph.
 */
export const layoutColumns = (paneWidth: number, widestLane: number): Columns => {
  const graphNeeds = graphWidthFor(widestLane)
  const choices = [
    { showAuthor: true, showDate: true, showCommit: true },
    { showAuthor: false, showDate: true, showCommit: true },
    { showAuthor: false, showDate: true, showCommit: false },
    { showAuthor: false, showDate: false, showCommit: false },
  ]
  type Choice = (typeof choices)[number]
  const optional = (c: Choice) =>
    [c.showAuthor && authorWidth, c.showDate && dateWidth, c.showCommit && commitWidth].filter((w): w is number => typeof w === "number")
  const fixedWidth = (c: Choice) => listInset * 2 + optional(c).reduce((sum, w) => sum + w + gap, gap)
  const choice = choices.find((c) => paneWidth - fixedWidth(c) >= minDescription + minGraph) ?? choices[choices.length - 1]!
  const graph = Math.max(minGraph, Math.min(graphNeeds, maxGraph, paneWidth - fixedWidth(choice) - minDescription))
  const template = [`${graph}px`, "minmax(0,1fr)", ...optional(choice).map((w) => `${w}px`)].join(" ")
  return { graph, graphNeeds, ...choice, template }
}
