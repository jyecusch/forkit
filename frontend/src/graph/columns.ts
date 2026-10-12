import { gutter, laneWidth } from "./geometry"

/** Horizontal padding of the commit list, both sides together. */
export const listPadding = 28
const gap = 12
const commitWidth = 72
const dateWidth = 100
const authorWidth = 140
const minDescription = 220
const minGraph = 64
/** The graph never takes more than this share of the pane. */
const maxGraphShare = 0.35

export interface Columns {
  /** Width of the graph column; lanes beyond it are reached by panning. */
  readonly graph: number
  /** Width the graph would need to show every lane. */
  readonly graphNeeds: number
  readonly showAuthor: boolean
  readonly showDate: boolean
  /** CSS grid-template-columns for the header and every row. */
  readonly template: string
}

/**
 * Sizes the commit list's columns for the pane width. The description gets
 * what is left after the others, never less than minDescription; author and
 * then date are dropped when the pane is too narrow for them.
 */
export const layoutColumns = (paneWidth: number, laneCount: number): Columns => {
  const graphNeeds = gutter * 2 + Math.max(laneCount - 1, 0) * laneWidth
  const choices = [
    { showAuthor: true, showDate: true },
    { showAuthor: false, showDate: true },
    { showAuthor: false, showDate: false },
  ]
  const fixedWidth = ({ showAuthor, showDate }: (typeof choices)[number]) =>
    listPadding + commitWidth + gap * (2 + Number(showAuthor) + Number(showDate)) + (showAuthor ? authorWidth : 0) + (showDate ? dateWidth : 0)
  const choice = choices.find((c) => paneWidth - fixedWidth(c) >= minDescription + minGraph) ?? choices[choices.length - 1]!
  const room = paneWidth - fixedWidth(choice) - minDescription
  const graph = Math.max(minGraph, Math.min(graphNeeds, paneWidth * maxGraphShare, room))
  const template = [
    `${graph}px`,
    "minmax(0,1fr)",
    choice.showAuthor && `${authorWidth}px`,
    choice.showDate && `${dateWidth}px`,
    `${commitWidth}px`,
  ]
    .filter(Boolean)
    .join(" ")
  return { graph, graphNeeds, ...choice, template }
}
