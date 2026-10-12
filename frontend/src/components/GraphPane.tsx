import { useVirtualizer } from "@tanstack/react-virtual"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useForkedEffect } from "@/app/hooks"
import { useService } from "@/app/services"
import { layoutColumns, listPadding } from "@/graph/columns"
import { drawGraph, readPalette, type GraphPalette } from "@/graph/draw"
import { geometry, laneX, rowHeight } from "@/graph/geometry"
import { formatDate, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GraphView, Preferences, Ref, RefId, RepoId } from "@/model/model.gen"
import { GraphData, type LoadedRow } from "@/services/GraphData"
import { RefBadge } from "./RefBadge"

/** Rows rendered beyond the viewport on each side, for rows and graph alike. */
const overscan = 30
/** Badges shown before the rest are summarised as "+N". */
const maxBadges = 2

export interface ScrollRequest {
  readonly row: number
  /** Distinguishes repeated requests for the same row. */
  readonly nonce: number
}

interface GraphPaneProps {
  readonly repo: RepoId
  readonly view: GraphView
  readonly emphasized: RefId | undefined
  readonly refsById: ReadonlyMap<string, Ref>
  /** Commits checked out in some worktree, drawn as rings. */
  readonly headOids: ReadonlySet<string>
  /** The active worktree's branch, labelled HEAD. */
  readonly headRef: RefId | undefined
  readonly selected: LoadedRow | undefined
  readonly onSelect: (row: LoadedRow) => void
  readonly scrollRequest: ScrollRequest | undefined
  readonly preferences: Preferences
}

/**
 * The commit list: virtualized DOM rows for text, with the graph drawn on a
 * canvas behind the rendered rows. The canvas is part of the scrolled
 * content, so it moves with the rows on every frame and only needs redrawing
 * when the rendered range changes.
 */
export const GraphPane = (props: GraphPaneProps) => {
  const { repo, view, emphasized, preferences, scrollRequest } = props
  const graphData = useService(GraphData)
  const sectionRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [offsetX, setOffsetX] = useState(0)
  const [palette, setPalette] = useState<GraphPalette>()
  const [panToRow, setPanToRow] = useState<number>()

  const dataVersion = useSyncExternalStore(
    useCallback((listener) => graphData.subscribe(repo, listener), [graphData, repo]),
    useCallback(() => graphData.revision(repo), [graphData, repo]),
  )
  const paneWidth = useSize(sectionRef).width
  const viewportHeight = useSize(scrollRef).height

  const virtualizer = useVirtualizer({
    count: view.totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0

  useForkedEffect(() => graphData.ensure({ repo, view, emphasized, first, last }), [graphData, repo, view, emphasized, first, last])

  useEffect(() => {
    if (scrollRequest && scrollRequest.row >= 0) {
      virtualizer.scrollToIndex(scrollRequest.row, { align: "center" })
      setPanToRow(scrollRequest.row)
    }
  }, [scrollRequest, virtualizer])

  const theme = preferences.appearance.theme
  useEffect(() => {
    setPalette(readPalette(document.documentElement))
  }, [theme])

  const columns = layoutColumns(paneWidth, view.laneCount)
  const maxOffset = Math.max(columns.graphNeeds - columns.graph, 0)
  const clampedOffsetX = Math.min(offsetX, maxOffset)

  // Bring a row the user jumped to into view sideways once it has loaded.
  const panTarget = panToRow === undefined ? undefined : graphData.peek(repo, panToRow)
  useEffect(() => {
    if (!panTarget) return
    const x = laneX(panTarget.row.lane)
    if (x < clampedOffsetX || x > clampedOffsetX + columns.graph) {
      setOffsetX(Math.min(Math.max(x - columns.graph / 2, 0), maxOffset))
    }
    setPanToRow(undefined)
  }, [panTarget, clampedOffsetX, columns.graph, maxOffset])

  // The canvas covers every rendered row. Its height only changes with the
  // viewport, and resizing reallocates it, so that is kept out of drawing.
  const canvasRows = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1
  const canvasHeight = canvasRows * rowHeight
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(columns.graph * dpr)
    canvas.height = Math.round(canvasHeight * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [columns.graph, canvasHeight])

  const canvasTop = first * rowHeight
  useLayoutEffect(() => {
    const context = canvasRef.current?.getContext("2d")
    if (!context || !palette) return
    context.clearRect(0, 0, columns.graph, canvasHeight)
    drawGraph(
      context,
      geometry({
        first,
        last: Math.min(first + canvasRows, view.totalRows - 1),
        originY: canvasTop,
        offsetX: clampedOffsetX,
        rowAt: (index) => graphData.peek(repo, index),
        headOids: props.headOids,
        anyEmphasis: emphasized !== undefined,
      }),
      palette,
      preferences.graph.dimmedOpacity,
    )
  }, [
    graphData,
    repo,
    first,
    canvasTop,
    canvasRows,
    canvasHeight,
    clampedOffsetX,
    columns.graph,
    palette,
    dataVersion,
    emphasized,
    props.headOids,
    preferences.graph.dimmedOpacity,
    view.totalRows,
  ])

  const onWheel = (event: React.WheelEvent) => {
    const dx = event.shiftKey ? event.deltaY : event.deltaX
    if (dx !== 0 && maxOffset > 0) {
      setOffsetX((x) => Math.min(Math.max(Math.min(x, maxOffset) + dx, 0), maxOffset))
    }
  }

  const selectedOid = props.selected?.row.oid
  // Rows move when history changes, so the selection is a commit, and its
  // current row is looked up among the rows on screen.
  const selectedIndex = () =>
    items.find((item) => graphData.peek(repo, item.index)?.row.oid === selectedOid)?.index ?? props.selected?.row.index ?? -1
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const next = selectedIndex() + (event.key === "ArrowDown" ? 1 : -1)
    const loaded = next >= 0 ? graphData.peek(repo, next) : undefined
    if (loaded) {
      props.onSelect(loaded)
      virtualizer.scrollToIndex(next)
    }
  }

  const clippedLeft = clampedOffsetX > 0
  const clippedRight = clampedOffsetX < maxOffset
  return (
    <section ref={sectionRef} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="History">
      <div
        className="grid h-8 flex-none items-center gap-3 border-b text-xs font-medium whitespace-nowrap text-subtle-foreground"
        style={{ gridTemplateColumns: columns.template, paddingInline: listPadding / 2 }}
      >
        <span>Graph</span>
        <span>Description</span>
        {columns.showAuthor && <span>Author</span>}
        {columns.showDate && <span>Date</span>}
        <span>Commit</span>
      </div>
      <div
        ref={scrollRef}
        role="grid"
        aria-rowcount={view.totalRows}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        className="relative flex-1 overflow-y-auto outline-none"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => (
            <CommitRow
              key={item.key}
              index={item.index}
              top={item.start}
              loaded={graphData.peek(repo, item.index)}
              columns={columns.template}
              showAuthor={columns.showAuthor}
              showDate={columns.showDate}
              selected={selectedOid !== undefined && graphData.peek(repo, item.index)?.row.oid === selectedOid}
              anyEmphasis={emphasized !== undefined}
              refsById={props.refsById}
              headRef={props.headRef}
              dateFormat={preferences.appearance.dateFormat}
              onSelect={props.onSelect}
            />
          ))}
          <canvas
            ref={canvasRef}
            aria-hidden
            className="pointer-events-none absolute"
            style={{ top: canvasTop, left: listPadding / 2, width: columns.graph, height: canvasHeight }}
          />
        </div>
        <div className="pointer-events-none sticky bottom-0 h-0">
          {clippedLeft && <EdgeFade side="left" left={listPadding / 2} height={viewportHeight} />}
          {clippedRight && <EdgeFade side="right" left={listPadding / 2 + columns.graph - 24} height={viewportHeight} />}
        </div>
      </div>
    </section>
  )
}

/** Shades the edge of the graph where lanes continue out of view. */
const EdgeFade = ({ side, left, height }: { side: "left" | "right"; left: number; height: number }) => (
  <div
    className="absolute bottom-0 w-6"
    style={{
      left,
      height,
      background: `linear-gradient(to ${side === "left" ? "right" : "left"}, var(--background), transparent)`,
    }}
  />
)

/** Tracks an element's size as it is resized. */
const useSize = (ref: React.RefObject<HTMLElement | null>) => {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [ref])
  return size
}

interface CommitRowProps {
  readonly index: number
  readonly top: number
  readonly loaded: LoadedRow | undefined
  readonly columns: string
  readonly showAuthor: boolean
  readonly showDate: boolean
  readonly selected: boolean
  readonly anyEmphasis: boolean
  readonly refsById: ReadonlyMap<string, Ref>
  readonly headRef: RefId | undefined
  readonly dateFormat: Preferences["appearance"]["dateFormat"]
  readonly onSelect: (row: LoadedRow) => void
}

const CommitRow = memo(function CommitRow({
  index,
  top,
  loaded,
  columns,
  showAuthor,
  showDate,
  selected,
  anyEmphasis,
  refsById,
  headRef,
  dateFormat,
  onSelect,
}: CommitRowProps) {
  const style = { top, height: rowHeight, gridTemplateColumns: columns, paddingInline: listPadding / 2 }
  if (!loaded) {
    return (
      <div role="row" aria-rowindex={index + 1} className="absolute inset-x-0 grid items-center gap-3" style={style}>
        <span />
        <span className="h-2 w-2/3 rounded bg-muted" />
      </div>
    )
  }
  const { row, commit } = loaded
  const dim = anyEmphasis && !row.onEmphasized
  const isHead = headRef !== undefined && row.refIds.includes(headRef)
  // The checked-out branch first, so it is never hidden behind "+N".
  const refs = row.refIds.flatMap((id) => refsById.get(id) ?? []).sort((a, b) => Number(b.id === headRef) - Number(a.id === headRef))
  const meta = cn("truncate text-xs", dim ? "text-muted-foreground" : "text-secondary-foreground")
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      onClick={() => onSelect(loaded)}
      className={cn("absolute inset-x-0 grid cursor-default items-center gap-3", selected ? "bg-selection" : "hover:bg-accent/40")}
      style={style}
    >
      <span />
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {refs.slice(0, maxBadges).map((ref) => (
          <RefBadge key={ref.id} refEntity={ref} thread={row.threadId} dim={dim} isHead={ref.id === headRef} />
        ))}
        {refs.length > maxBadges && (
          <span
            className="flex-none text-[11px] text-subtle-foreground"
            title={refs.slice(maxBadges).map((ref) => ref.shortName).join("\n")}
          >
            +{refs.length - maxBadges}
          </span>
        )}
        <span
          className={cn("min-w-[4ch] flex-1 truncate", dim ? "text-subtle-foreground" : "text-foreground", isHead && "font-semibold")}
          title={commit.subject}
        >
          {commit.subject}
        </span>
      </span>
      {showAuthor && <span className={meta}>{commit.authorName}</span>}
      {showDate && <span className={meta}>{formatDate(commit.authorTime, dateFormat)}</span>}
      <span className={cn("font-mono text-xs", dim ? "text-muted-foreground" : "text-secondary-foreground")}>{shortOid(row.oid)}</span>
    </div>
  )
})
