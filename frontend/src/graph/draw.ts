import { rowHeight, type Geometry } from "./geometry"

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

/** Draws graph geometry onto a canvas sized for the device pixel ratio. */
export const drawGraph = (
  context: CanvasRenderingContext2D,
  geometry: Geometry,
  palette: GraphPalette,
  dimmedOpacity: number,
) => {
  const color = (thread: number) => palette.lanes[thread % palette.lanes.length]!
  context.lineCap = "round"
  for (const segment of geometry.segments) {
    context.globalAlpha = segment.emphasized ? 1 : dimmedOpacity
    context.lineWidth = segment.emphasized ? 2.5 : 1.5
    context.strokeStyle = color(segment.thread)
    context.beginPath()
    context.moveTo(segment.x1, segment.y1)
    if (segment.x1 === segment.x2) {
      context.lineTo(segment.x2, segment.y2)
    } else {
      // An S-curve that leaves and enters the rows vertically.
      const bend = rowHeight * 0.55
      context.bezierCurveTo(segment.x1, segment.y1 + bend, segment.x2, segment.y2 - bend, segment.x2, segment.y2)
    }
    context.stroke()
  }
  for (const dot of geometry.dots) {
    context.globalAlpha = dot.emphasized ? 1 : Math.max(dimmedOpacity + 0.1, 0.3)
    context.beginPath()
    context.arc(dot.x, dot.y, dot.emphasized ? 5 : 4, 0, Math.PI * 2)
    context.fillStyle = dot.hollow ? palette.background : color(dot.thread)
    context.fill()
    context.lineWidth = 2
    context.strokeStyle = color(dot.thread)
    context.stroke()
  }
  context.globalAlpha = 1
}
