import { rowHeight, type Dot, type Geometry, type Segment } from "./geometry"

/** Theme colours the canvas needs, read from CSS variables. */
export interface GraphPalette {
  readonly lanes: ReadonlyArray<string>
  readonly background: string
}

export const readPalette = (element: Element): GraphPalette => {
  const style = getComputedStyle(element)
  const lanes = Array.from({ length: 8 }, (_, i) => style.getPropertyValue(`--lane-${i}`).trim())
  return { lanes, background: style.getPropertyValue("--background").trim() }
}

const lineWidth = 2
const dotRadius = 4
/** Radius of the bend where a line changes lane. */
const elbowRadius = 8

/**
 * Draws graph geometry. Every line and dot is drawn opaque at the same size,
 * whatever the history looks like; lines outside the emphasized history are
 * only toned down towards the background. Transparency would make
 * overlapping strokes and dot outlines show through each other.
 */
export const drawGraph = (context: CanvasRenderingContext2D, geometry: Geometry, palette: GraphPalette, dimmedStrength: number) => {
  const colors = new Map<string, string>()
  const colorOf = (thread: number, emphasized: boolean) => {
    const key = `${thread % palette.lanes.length}:${emphasized}`
    let color = colors.get(key)
    if (!color) {
      const lane = palette.lanes[thread % palette.lanes.length]!
      color = emphasized ? lane : mixHex(lane, palette.background, dimmedStrength)
      colors.set(key, color)
    }
    return color
  }

  context.lineWidth = lineWidth
  context.lineCap = "butt"
  context.lineJoin = "round"
  for (const segment of geometry.segments) {
    context.strokeStyle = colorOf(segment.thread, segment.emphasized)
    context.beginPath()
    traceSegment(context, segment)
    context.stroke()
  }

  for (const dot of geometry.dots) {
    drawDot(context, dot, colorOf(dot.thread, dot.emphasized), palette.background)
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
  const outer = dot.shape === "head" ? dotRadius + 3 : dotRadius
  if (dot.shape !== "commit") {
    // Rings are hollow, so clear the lines that run into them.
    context.fillStyle = background
    circle(outer)
    context.fill()
  }

  switch (dot.shape) {
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
      context.fillStyle = color
      circle(dotRadius - 0.5)
      context.fill()
      context.strokeStyle = color
      context.lineWidth = 1.5
      circle(outer - 0.75)
      context.stroke()
      break
  }
  context.lineWidth = lineWidth
}

/** Mixes two #rrggbb colours: weight 1 gives a, 0 gives b. */
export const mixHex = (a: string, b: string, weight: number): string => {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [ca, cb] = [parse(a), parse(b)]
  const mixed = ca.map((channel, i) => Math.round(channel * weight + cb[i]! * (1 - weight)))
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}
