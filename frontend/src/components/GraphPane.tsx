import { useVirtualizer } from "@tanstack/react-virtual"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useForkedEffect } from "@/app/hooks"
import { useService } from "@/app/services"
import { drawGraph, readPalette, type GraphPalette } from "@/graph/draw"
import { geometry, gutter, laneWidth, rowHeight } from "@/graph/geometry"
import { formatDate, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GraphView, Preferences, Ref, RefId, RepoId } from "@/model/model.gen"
import { GraphData, type LoadedRow } from "@/services/GraphData"
import { RefBadge } from "./RefBadge"

const minGraphWidth = 96
const maxGraphWidth = 360

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
 * canvas pinned over the visible part of the first column.
 */
export const GraphPane = (props: GraphPaneProps) => {
  const { repo, view, emphasized, preferences, scrollRequest } = props
  const graphData = useService(GraphData)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [offsetX, setOffsetX] = useState(0)
  const [palette, setPalette] = useState<GraphPalette>()

  const dataVersion = useSyncExternalStore(
    useCallback((listener) => graphData.subscribe(repo, listener), [graphData, repo]),
    useCallback(() => graphData.revision(repo), [graphData, repo]),
  )
  const viewportHeight = useHeight(scrollRef)

  const virtualizer = useVirtualizer({
    count: view.totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 30,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0

  useForkedEffect(() => graphData.ensure({ repo, view, emphasized, first, last }), [graphData, repo, view, emphasized, first, last])

  useEffect(() => {
    if (scrollRequest && scrollRequest.row >= 0) {
      virtualizer.scrollToIndex(scrollRequest.row, { align: "center" })
    }
  }, [scrollRequest, virtualizer])

  const theme = preferences.appearance.theme
  useEffect(() => {
    setPalette(readPalette(document.documentElement))
  }, [theme])

  const fullWidth = gutter * 2 + Math.max(view.laneCount - 1, 0) * laneWidth
  const graphWidth = Math.min(Math.max(fullWidth, minGraphWidth), maxGraphWidth)
  const maxOffset = Math.max(fullWidth - graphWidth, 0)
  const clampedOffsetX = Math.min(offsetX, maxOffset)

  // Resizing a canvas reallocates and clears it, so it happens only when the
  // size changes, not on every scroll frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) {
      return
    }
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(graphWidth * dpr)
    canvas.height = Math.round(viewportHeight * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [graphWidth, viewportHeight])

  const scrollTop = virtualizer.scrollOffset ?? 0
  useLayoutEffect(() => {
    const context = canvasRef.current?.getContext("2d")
    if (!context || !palette) {
      return
    }
    context.clearRect(0, 0, graphWidth, viewportHeight)
    drawGraph(
      context,
      geometry({
        first: Math.floor(scrollTop / rowHeight),
        last: Math.min(Math.ceil((scrollTop + viewportHeight) / rowHeight), view.totalRows - 1),
        scrollTop,
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
    scrollTop,
    viewportHeight,
    clampedOffsetX,
    graphWidth,
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
      setOffsetX((x) => Math.min(Math.max(x + dx, 0), maxOffset))
    }
  }

  const selectedOid = props.selected?.row.oid
  // Rows move when history changes, so the selection is a commit, and its
  // current row is looked up among the rows on screen.
  const selectedIndex = () =>
    items.find((item) => graphData.peek(repo, item.index)?.row.oid === selectedOid)?.index ?? props.selected?.row.index ?? -1
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return
    }
    event.preventDefault()
    const next = selectedIndex() + (event.key === "ArrowDown" ? 1 : -1)
    const loaded = next >= 0 ? graphData.peek(repo, next) : undefined
    if (loaded) {
      props.onSelect(loaded)
      virtualizer.scrollToIndex(next)
    }
  }

  const columns = `${graphWidth}px minmax(0,1fr) 150px 110px 72px`
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="History">
      <div
        className="grid gap-3 border-b px-3.5 py-1.5 text-[11px] font-semibold tracking-wider text-subtle-foreground uppercase"
        style={{ gridTemplateColumns: columns }}
      >
        <span>Graph</span>
        <span>Description</span>
        <span>Author</span>
        <span>Date</span>
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
        <div className="pointer-events-none sticky top-0 z-10 h-0">
          <canvas
            ref={canvasRef}
            aria-hidden
            className="absolute top-0 left-3.5"
            style={{ width: graphWidth, height: viewportHeight }}
          />
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => (
            <CommitRow
              key={item.key}
              index={item.index}
              top={item.start}
              loaded={graphData.peek(repo, item.index)}
              columns={columns}
              selected={selectedOid !== undefined && graphData.peek(repo, item.index)?.row.oid === selectedOid}
              anyEmphasis={emphasized !== undefined}
              refsById={props.refsById}
              headRef={props.headRef}
              dateFormat={preferences.appearance.dateFormat}
              onSelect={props.onSelect}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

/** Tracks an element's height as it is resized. */
const useHeight = (ref: React.RefObject<HTMLElement | null>) => {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    setHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [ref])
  return height
}

interface CommitRowProps {
  readonly index: number
  readonly top: number
  readonly loaded: LoadedRow | undefined
  readonly columns: string
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
  selected,
  anyEmphasis,
  refsById,
  headRef,
  dateFormat,
  onSelect,
}: CommitRowProps) {
  const style = { top, height: rowHeight, gridTemplateColumns: columns }
  if (!loaded) {
    return (
      <div role="row" aria-rowindex={index + 1} className="absolute inset-x-0 grid items-center gap-3 px-3.5" style={style}>
        <span />
        <span className="h-2 w-2/3 rounded bg-muted" />
      </div>
    )
  }
  const { row, commit } = loaded
  const dim = anyEmphasis && !row.onEmphasized
  const isHead = headRef !== undefined && row.refIds.includes(headRef)
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      onClick={() => onSelect(loaded)}
      className={cn(
        "absolute inset-x-0 grid cursor-default items-center gap-3 px-3.5",
        selected ? "bg-selection" : "hover:bg-accent/40",
      )}
      style={style}
    >
      <span />
      <span className="flex min-w-0 items-center gap-1.5">
        {row.refIds.map((id) => {
          const ref = refsById.get(id)
          return ref && <RefBadge key={id} refEntity={ref} thread={row.threadId} dim={dim} isHead={id === headRef} />
        })}
        <span className={cn("truncate", dim ? "text-subtle-foreground" : "text-foreground", isHead && "font-semibold")}>
          {commit.subject}
        </span>
      </span>
      <span className={cn("truncate text-xs", dim ? "text-muted-foreground" : "text-secondary-foreground")}>
        {commit.authorName}
      </span>
      <span className={cn("truncate text-xs", dim ? "text-muted-foreground" : "text-secondary-foreground")}>
        {formatDate(commit.authorTime, dateFormat)}
      </span>
      <span className={cn("font-mono text-xs", dim ? "text-muted-foreground" : "text-secondary-foreground")}>
        {shortOid(row.oid)}
      </span>
    </div>
  )
})
