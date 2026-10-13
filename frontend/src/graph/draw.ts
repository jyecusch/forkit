import { rowHeight, type Dot, type Geometry, type Segment } from "./geometry"

/** Theme colours the canvas needs, read from CSS variables. */
export interface GraphPalette {
  readonly lanes: ReadonlyArray<string>
  readonly background: string
  /** The uncommitted changes' line, which has no branch colour of its own. */
  readonly uncommitted: string
  /** Stashes and their lines, quieter than any branch. */
  readonly stash: string
}

export const readPalette = (element: Element): GraphPalette => {
  const style = getComputedStyle(element)
  const lanes = Array.from({ length: 8 }, (_, i) => style.getPropertyValue(`--lane-${i}`).trim())
  const background = style.getPropertyValue("--background").trim()
  const uncommitted = mixHex(style.getPropertyValue("--highlight").trim(), background, dashedLine.strength)
  const stash = style.getPropertyValue("--subtle-foreground").trim()
  return { lanes, background, uncommitted, stash }
}

const lineWidth = 2

/**
 * The lines from uncommitted changes and stashes are lighter than history's:
 * thinner, faded, and dashed. The pattern divides the row height, so every
 * row's piece continues the dashes of the one above.
 */
export const dashedLine = { width: 1.25, dash: [2, 2] as const, strength: 0.85 }
const dotRadius = 4
/** Radius of the bend where a line changes lane. */
const elbowRadius = 8

export interface DrawOptions {
  readonly width: number
  readonly height: number
  /** Lanes continue past this edge, so it fades out. */
  readonly fadeLeft: boolean
  readonly fadeRight: boolean
}

/** Width of the fade at an edge lanes continue past. */
const fadeWidth = 16

/**
 * Draws graph geometry. Every line and dot is drawn opaque, in its thread's
 * colour, at the same size; the emphasized history stands out through the
 * rows' text rather than the lines.
 *
 * Where lanes continue past an edge the graph fades out, and a commit whose
 * dot is past it gets a marker on that edge, drawn after the fade so every
 * row still shows where its commit is.
 */
export const drawGraph = (context: CanvasRenderingContext2D, geometry: Geometry, palette: GraphPalette, options: DrawOptions) => {
  const { width, height } = options
  const colorOf = (thread: number) => palette.lanes[thread % palette.lanes.length]!
  const dotColor = (dot: Dot) => (dot.shape === "stash" ? palette.stash : colorOf(dot.thread))

  context.lineWidth = lineWidth
  context.lineCap = "butt"
  context.lineJoin = "round"
  for (const segment of geometry.segments) {
    const dashed = segment.line !== "history"
    context.strokeStyle = dashed ? palette[segment.line] : colorOf(segment.thread)
    context.lineWidth = dashed ? dashedLine.width : lineWidth
    context.setLineDash(dashed ? [...dashedLine.dash] : [])
    context.beginPath()
    traceSegment(context, segment)
    context.stroke()
  }
  context.setLineDash([])
  context.lineWidth = lineWidth

  const clipped: Array<Dot> = []
  for (const dot of geometry.dots) {
    if (dot.x < 0 || dot.x > width) clipped.push(dot)
    else drawDot(context, dot, dotColor(dot), palette.background)
  }

  context.save()
  context.globalCompositeOperation = "destination-out"
  for (const [fade, x] of [
    [options.fadeLeft, 0],
    [options.fadeRight, width - fadeWidth],
  ] as const) {
    if (!fade) continue
    const gradient = context.createLinearGradient(x, 0, x + fadeWidth, 0)
    gradient.addColorStop(x === 0 ? 0 : 1, "black")
    gradient.addColorStop(x === 0 ? 1 : 0, "transparent")
    context.fillStyle = gradient
    context.fillRect(x, 0, fadeWidth, height)
  }
  context.restore()

  for (const dot of clipped) {
    const edge = dot.x < 0 ? 0 : width
    context.fillStyle = dotColor(dot)
    context.beginPath()
    context.arc(edge, dot.y, dotRadius, 0, Math.PI * 2)
    context.fill()
  }
}

/**
 * Lane changes bend once, at the commit's own row: a fork leaves its commit
 * sideways and then runs down its new lane; a merge runs down its lane and
 * then turns sideways into the commit.
 */
const traceSegment = (context: CanvasRenderingContext2D, { x1, y1, x2, y2, kind }: Segment) => {
  context.moveTo(x1, y1)
  if (x1 === x2) {
    context.lineTo(x2, y2)
    return
  }
  const radius = Math.min(elbowRadius, Math.abs(x2 - x1), rowHeight / 2)
  if (kind === "fork") {
    context.arcTo(x2, y1, x2, y2, radius)
  } else {
    context.arcTo(x1, y2, x2, y2, radius)
  }
  context.lineTo(x2, y2)
}

const drawDot = (context: CanvasRenderingContext2D, dot: Dot, color: string, background: string) => {
  const circle = (radius: number) => {
    context.beginPath()
    context.arc(dot.x, dot.y, radius, 0, Math.PI * 2)
  }
  const outer = dot.shape === "head" || dot.shape === "worktree" ? dotRadius + 2 : dotRadius
  if (dot.shape !== "commit") {
    // Rings are hollow, so clear the lines that run into them.
    context.fillStyle = background
    circle(outer)
    context.fill()
  }

  switch (dot.shape) {
    case "stash":
      drawStash(context, dot, color, background)
      break
    case "commit":
      context.fillStyle = color
      circle(dotRadius)
      context.fill()
      break
    case "merge":
      context.strokeStyle = color
      context.lineWidth = lineWidth
      circle(dotRadius - lineWidth / 2)
      context.stroke()
      break
    case "head":
    case "worktree":
      context.fillStyle = color
      circle(dotRadius - 1)
      context.fill()
      context.strokeStyle = dot.shape === "head" ? color : mixHex(color, background, 0.5)
      context.lineWidth = dot.shape === "head" ? 1.5 : 1
      circle(outer - context.lineWidth / 2)
      context.stroke()
      break
  }
  context.lineWidth = lineWidth
}

/**
 * The pixels of a stash's mark, a 13-pixel square holding an archive box:
 * [x, y, width, height] from its top-left corner. Whole pixels, so it stays
 * sharp on screens of every density, where a scaled vector icon would blur.
 */
const stashSize = 13
const stashPixels: ReadonlyArray<readonly [number, number, number, number]> = [
  // The square's edges.
  [0, 0, 13, 1],
  [0, 12, 13, 1],
  [0, 1, 1, 11],
  [12, 1, 1, 11],
  // The box's lid, its sides and bottom, and its handle.
  [2, 3, 9, 2],
  [3, 5, 1, 5],
  [9, 5, 1, 5],
  [3, 9, 7, 1],
  [5, 6, 3, 1],
]

/** Draws a stash's mark centred on dot, aligned to the device's pixel grid. */
const drawStash = (context: CanvasRenderingContext2D, dot: Dot, color: string, background: string) => {
  const scale = context.getTransform().a || 1
  const snap = (value: number) => Math.round(value * scale) / scale
  const left = snap(dot.x - stashSize / 2)
  const top = snap(dot.y - stashSize / 2)
  context.fillStyle = background
  context.fillRect(left, top, stashSize, stashSize)
  context.fillStyle = color
  for (const [x, y, width, height] of stashPixels) context.fillRect(left + x, top + y, width, height)
}

/** Mixes two #rrggbb colours: weight 1 gives a, 0 gives b. */
export const mixHex = (a: string, b: string, weight: number): string => {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [ca, cb] = [parse(a), parse(b)]
  const mixed = ca.map((channel, i) => Math.round(channel * weight + cb[i]! * (1 - weight)))
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}
