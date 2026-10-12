import { gutter, laneWidth } from "./geometry"

/** Horizontal inset of the commit list's content, each side. */
export const listInset = 12
const gap = 12
const commitWidth = 64
const dateWidth = 96
const authorWidth = 120
const minDescription = 320
const maxGraph = 160
/** The graph's share of a wide pane, when that is more than maxGraph. */
const graphShare = 0.25
/** Lanes the graph keeps before optional columns are dropped for it. */
const comfortableLanes = 3

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
const graphWidthFor = (widestLane: number) => gutter * 2 + Math.max(widestLane, 0) * laneWidth

/**
 * Sizes the commit list's columns for a graph of the given lanes. The
 * description always keeps at least minDescription, and the graph a few
 * lanes; author, then commit, then date make way for them on narrow panes.
 * The graph then takes what its lanes need, up to a quarter of the pane.
 */
export const layoutColumns = (paneWidth: number, lanes: number): Columns => {
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
    [c.showAuthor && authorWidth, c.showDate && dateWidth, c.showCommit && commitWidth].filter((w): w is number => typeof w === "number")
  const fixedWidth = (c: Choice) => listInset * 2 + optional(c).reduce((sum, w) => sum + w + gap, gap)
  const choice = choices.find((c) => paneWidth - fixedWidth(c) >= minDescription + minGraph) ?? choices[choices.length - 1]!
  const budget = Math.min(Math.max(maxGraph, Math.round(paneWidth * graphShare)), paneWidth - fixedWidth(choice) - minDescription)
  const graph = Math.max(gutter * 2, Math.min(graphNeeds, budget))
  const template = [`${graph}px`, "minmax(0,1fr)", ...optional(choice).map((w) => `${w}px`)].join(" ")
  return { graph, graphNeeds, ...choice, template }
}
