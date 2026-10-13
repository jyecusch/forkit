import { useVirtualizer } from "@tanstack/react-virtual"
import { Effect } from "effect"
import { Asterisk } from "lucide-react"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useForkedEffect, useResolvedTheme } from "@/app/hooks"
import { useLayoutSize, type LayoutSizeControl } from "@/app/layoutSizes"
import { useService } from "@/app/services"
import { columnGap, layoutColumns, listInset } from "@/graph/columns"
import { drawGraph, readPalette, uncommittedLine, type GraphPalette } from "@/graph/draw"
import { geometry, gutter, laneWidth, laneX, rowHeight, widestLane } from "@/graph/geometry"
import { notify } from "@/app/notifications"
import { useNow } from "@/app/useNow"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { badgesFor } from "@/lib/badges"
import { formatDate, formatFullDate, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GraphView, Preferences, Ref, RefId, RepoId, Worktree } from "@/model/model.gen"
import { GraphData, type LoadedRow } from "@/services/GraphData"
import { focusIsLost } from "./Chrome"
import { laneColor, RefBadge } from "./RefBadge"
import { ResizeHandle } from "./ResizeHandle"

/** Rows rendered beyond the viewport on each side, for rows and graph alike. */
const overscan = 30
/** Badges shown in the narrow label column before the rest are summarised as "+N". */
const maxBadges = 1

export interface ScrollRequest {
  /** A commit's row, or the uncommitted changes above them all. */
  readonly row: number | "changes"
  /** Distinguishes repeated requests for the same row. */
  readonly nonce: number
}

interface GraphPaneProps {
  readonly repo: RepoId
  readonly view: GraphView
  readonly emphasized: RefId | undefined
  readonly refsById: ReadonlyMap<string, Ref>
  /** Every worktree, so a branch checked out in one can show it. */
  readonly worktreesById: ReadonlyMap<string, Worktree>
  /** Commits checked out in some worktree, drawn as rings. */
  readonly headOids: ReadonlySet<string>
  /** The active worktree's branch, labelled HEAD. */
  readonly headRef: RefId | undefined
  readonly selected: LoadedRow | undefined
  /** The active worktree's checked-out commit: ringed, and selected until the user picks one. */
  readonly activeHead: string | undefined
  readonly onSelect: (row: LoadedRow) => void
  /** Uncommitted changes in the active worktree; with any, a row for them heads the history. */
  readonly changes: number
  /** The checked-out commit's row, which the uncommitted changes row joins. */
  readonly headRow: number | undefined
  readonly changesSelected: boolean
  readonly onSelectChanges: () => void
  readonly scrollRequest: ScrollRequest | undefined
  /** Whether this list is on screen; hidden lists neither load nor draw. */
  readonly active: boolean
  readonly preferences: Preferences
}

/**
 * The commit list: virtualized DOM rows for text, with the graph drawn on a
 * canvas behind the rendered rows. The canvas is part of the scrolled
 * content, so it moves with the rows on every frame and only needs redrawing
 * when the rendered range changes.
 */
export const GraphPane = (props: GraphPaneProps) => {
  const { repo, view, emphasized, preferences, scrollRequest, active } = props
  const graphData = useService(GraphData)
  const sectionRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [offsetX, setOffsetX] = useState(0)
  const [palette, setPalette] = useState<GraphPalette>()
  const [panToRow, setPanToRow] = useState<number>()
  const [pendingSelect, setPendingSelect] = useState<number>()
  // The row the keyboard last moved to, so presses that arrive before the
  // selection catches up still count from it.
  const keyedRow = useRef<number>(undefined)

  const now = useNow()
  const dataVersion = useSyncExternalStore(
    useCallback((listener) => graphData.subscribe(repo, listener), [graphData, repo]),
    useCallback(() => graphData.revision(repo), [graphData, repo]),
  )
  const paneWidth = useSize(sectionRef).width
  const viewportHeight = useSize(scrollRef).height

  // The uncommitted changes row sits in space kept above the commits, so
  // commit rows keep their numbering.
  const wip = props.changes > 0
  const wipHeight = wip ? rowHeight : 0
  const virtualizer = useVirtualizer({
    count: view.totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    paddingStart: wipHeight,
    overscan,
    // Keyboard moves keep a little context visible past the selection.
    scrollPaddingStart: rowHeight * 2,
    scrollPaddingEnd: rowHeight * 2,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0

  useForkedEffect(
    () => (active ? graphData.ensure({ repo, view, emphasized, first, last }) : Effect.void),
    [active, graphData, repo, view, emphasized, first, last],
  )

  // The list takes focus when it first appears, if nothing else has it.
  // Later activations are left to the layer, which restores what had focus.
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (!active || focusedOnce.current) return
    focusedOnce.current = true
    if (focusIsLost()) scrollRef.current?.focus({ preventScroll: true })
  }, [active])

  // Jumps (to a ref, to either end, back to this tab) re-size the graph for
  // where they land; scrolling only ever widens it.
  // A jump records the first row it lands on, which the graph is sized
  // from until the list has scrolled there.
  const [jump, setJump] = useState<{ readonly nonce: number; readonly landing?: number }>({ nonce: 0 })
  const jumpTo = (landing?: number) => setJump((last) => ({ nonce: last.nonce + 1, ...(landing !== undefined && { landing }) }))
  const viewportRows = Math.ceil(viewportHeight / rowHeight)
  useEffect(() => {
    if (active) setJump((last) => ({ nonce: last.nonce + 1 }))
  }, [active])

  // A row jumped to is centred, selected and brought into view sideways.
  useEffect(() => {
    if (!scrollRequest) return
    if (scrollRequest.row === "changes") {
      virtualizer.scrollToOffset(0)
      setJump((last) => ({ nonce: last.nonce + 1, landing: 0 }))
      return
    }
    if (scrollRequest.row < 0) return
    const top = Math.max(wipHeight + scrollRequest.row * rowHeight - (virtualizer.scrollRect?.height ?? 0) / 2 + rowHeight / 2, 0)
    virtualizer.scrollToOffset(top)
    setPendingSelect(scrollRequest.row)
    setPanToRow(scrollRequest.row)
    setJump((last) => ({ nonce: last.nonce + 1, landing: Math.floor(top / rowHeight) }))
  }, [scrollRequest, virtualizer])

  const { theme } = useResolvedTheme()
  useEffect(() => {
    setPalette(readPalette(document.documentElement))
  }, [theme])

  // The graph is sized for the lanes on screen, plus one spare. It never
  // changes under a moving list: it widens once the reader pauses with rows
  // clipped, narrows after a longer rest, and starts afresh after a jump.
  // The virtualizer knows about a scroll before the scroll listener does.
  const scrolling = useScrolling(scrollRef, pauseAfter) || virtualizer.isScrolling
  // Narrowing moves text, so it waits until the pointer has left the list
  // and no menu is open.
  const [pointerOver, setPointerOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const onMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open)
    // An open menu stops pointer events reaching the list, so look again.
    if (!open) setPointerOver(sectionRef.current?.matches(":hover") ?? false)
  }, [])
  const resting = !useScrolling(scrollRef, restAfter) && !pointerOver && !menuOpen && !scrolling
  const viewportFirst = jump.landing ?? Math.floor((virtualizer.scrollOffset ?? 0) / rowHeight)
  const viewportWidest = widestLane(viewportFirst - 3, viewportFirst + viewportRows + 3, (index) => graphData.peek(repo, index))

  const lanes = useRatchet(viewportWidest < 0 ? 0 : Math.max(viewportWidest + 2, 2), { scrolling, resting, reset: jump.nonce })
  const refsWidth = useLayoutSize("refsColumn")
  const graphWidth = useLayoutSize("graphColumn")
  const authorWidth = useLayoutSize("authorColumn")
  const columns = layoutColumns(paneWidth, lanes, {
    refs: refsWidth.size,
    graph: graphWidth.size,
    author: authorWidth.size,
  })
  const maxOffset = Math.max(laneX(viewportWidest) + gutter - columns.graph, 0)


  // When the column grows enough for the rows on screen, stop panning.
  useEffect(() => {
    if (maxOffset === 0) setOffsetX(0)
  }, [maxOffset])
  const clampedOffsetX = Math.min(offsetX, maxOffset)

  // Bring a row the user jumped to into view sideways once it has loaded.
  // Select a row the keyboard moved to once it has loaded.
  const pendingRow = pendingSelect === undefined ? undefined : graphData.peek(repo, pendingSelect)
  const { onSelect: selectRow } = props
  // Selecting a row brings its lane into view if it is panned away.
  const onSelect = useCallback(
    (loaded: LoadedRow) => {
      keyedRow.current = undefined
      selectRow(loaded)
      setPanToRow(loaded.row.index)
    },
    [selectRow],
  )
  useEffect(() => {
    if (!pendingRow) return
    onSelect(pendingRow)
    setPendingSelect(undefined)
  }, [pendingRow, onSelect])

  const defaultRow = items.find((item) => graphData.peek(repo, item.index)?.row.oid === props.activeHead)
  const defaultLoaded = props.selected || !defaultRow ? undefined : graphData.peek(repo, defaultRow.index)
  useEffect(() => {
    if (defaultLoaded) onSelect(defaultLoaded)
  }, [defaultLoaded, onSelect])

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

  const canvasTop = wipHeight + first * rowHeight
  useLayoutEffect(() => {
    const context = canvasRef.current?.getContext("2d")
    if (!context || !palette || !active) return
    context.clearRect(0, 0, columns.graph, canvasHeight)
    drawGraph(
      context,
      geometry({
        first,
        last: Math.min(first + canvasRows, view.totalRows - 1),
        originY: first * rowHeight,
        offsetX: clampedOffsetX,
        rowAt: (index) => graphData.peek(repo, index),
        activeHead: props.activeHead,
        headOids: props.headOids,
      }),
      palette,
      {
        width: columns.graph,
        height: canvasHeight,
        fadeLeft: clampedOffsetX > 0,
        fadeRight: clampedOffsetX < maxOffset,
      },
    )
  }, [
    active,
    maxOffset,
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
    props.headOids,
    props.activeHead,
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
  const pageRows = Math.max(Math.floor(viewportHeight / rowHeight) - 1, 1)
  const selectChanges = () => {
    props.onSelectChanges()
    keyedRow.current = undefined
    virtualizer.scrollToOffset(0)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Up from the first commit reaches the uncommitted changes, and down from them the first commit.
    if (wip && props.changesSelected && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home")) {
      event.preventDefault()
      if (event.key === "ArrowDown") {
        virtualizer.scrollToIndex(0)
        setPendingSelect(0)
        keyedRow.current = 0
      }
      return
    }
    if (wip && !props.changesSelected && (event.key === "Home" || (event.key === "ArrowUp" && (keyedRow.current ?? selectedIndex()) === 0))) {
      event.preventDefault()
      selectChanges()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "c" && props.selected) {
      copySha(props.selected.row.oid)
      return
    }
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault()
      const step = event.key === "ArrowLeft" ? -laneWidth : laneWidth
      setOffsetX((x) => Math.min(Math.max(Math.min(x, maxOffset) + step, 0), maxOffset))
      return
    }
    const current = selectedIndex()
    // With nothing selected, the arrows start from the first row on screen.
    const firstVisible = Math.floor((virtualizer.scrollOffset ?? 0) / rowHeight)
    const from = keyedRow.current ?? (current >= 0 ? current : firstVisible - 1)
    const target = {
      ArrowDown: from + 1,
      ArrowUp: Math.max(from - 1, 0),
      PageDown: from + pageRows,
      PageUp: Math.max(from - pageRows, 0),
      Home: 0,
      End: view.totalRows - 1,
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    const next = Math.min(target, view.totalRows - 1)
    virtualizer.scrollToIndex(next)
    setPendingSelect(next)
    keyedRow.current = next
    if (event.key === "Home") jumpTo(0)
    if (event.key === "End") jumpTo(Math.max(view.totalRows - viewportRows, 0))
  }

  return (
    <section
      ref={sectionRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="History"
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
    >
      <div
        className="grid h-8 flex-none items-center gap-3 overflow-y-hidden border-b text-xs font-medium whitespace-nowrap text-subtle-foreground [scrollbar-gutter:stable]"
        style={{ gridTemplateColumns: columns.template, paddingInline: listInset }}
      >
        <ColumnHeader name="branch and tag" edge="right" control={refsWidth} width={columns.refs} limits={[80, 400]} className="text-right">
          Branch / Tag
        </ColumnHeader>
        <ColumnHeader name="graph" edge="right" control={graphWidth} width={columns.graph} limits={[graphMin, 800]} />
        <span>Description</span>
        {columns.showAuthor && (
          <ColumnHeader name="author" edge="left" control={authorWidth} width={columns.author} limits={[56, 320]}>
            Author
          </ColumnHeader>
        )}
      </div>
      <div
        ref={scrollRef}
        role="grid"
        aria-rowcount={view.totalRows}
        aria-label="Commits"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        onScroll={() => jump.landing !== undefined && setJump(({ nonce }) => ({ nonce }))}
        className="group/grid relative flex-1 overflow-y-auto outline-none [scrollbar-gutter:stable]"
      >
        <div
          className="relative overflow-hidden"
          style={
            {
              height: virtualizer.getTotalSize(),
              "--graph-offset": `${clampedOffsetX}px`,
              "--graph-width": `${columns.graph}px`,
            } as React.CSSProperties
          }
        >
          {items.map((item) => (
            <CommitRow
              key={item.key}
              index={item.index}
              top={item.start}
              loaded={graphData.peek(repo, item.index)}
              columns={columns.template}
              labelsEnd={columns.graphLeft - columnGap}
              showAuthor={columns.showAuthor}
              selected={!props.changesSelected && selectedOid !== undefined && graphData.peek(repo, item.index)?.row.oid === selectedOid}
              anyEmphasis={emphasized !== undefined}
              refsById={props.refsById}
              worktreesById={props.worktreesById}
              headRef={props.headRef}
              emphasized={emphasized}
              dateFormat={preferences.appearance.dateFormat}
              now={now}
              onSelect={onSelect}
              onMenuOpenChange={onMenuOpenChange}
            />
          ))}
          {wip && (
            <ChangesRow
              columns={columns.template}
              count={props.changes}
              selected={props.changesSelected}
              onSelect={selectChanges}
            />
          )}
          <canvas
            ref={canvasRef}
            aria-hidden
            className="pointer-events-none absolute"
            style={{ top: canvasTop, left: columns.graphLeft, width: columns.graph, height: canvasHeight }}
          />
          {wip && (
            <ChangesNode
              left={columns.graphLeft}
              x={laneX(0) - clampedOffsetX}
              width={columns.graph}
              // The line continues down the first lane, which the layout keeps
              // for it, unless the changes build on the first commit itself.
              joinsFirstRow={props.headRow === 0}
            />
          )}
        </div>
      </div>
    </section>
  )
}

/** The graph is never narrower than one lane with its gutters. */
const graphMin = gutter * 2 + laneWidth

/**
 * A column's header with a handle to resize it, on the edge away from the
 * description, which takes whatever width is left.
 */
const ColumnHeader = ({
  name,
  edge,
  control,
  width,
  limits,
  className,
  children,
}: {
  /** The column, for the handle's label. */
  name: string
  edge: "left" | "right"
  control: LayoutSizeControl
  width: number
  limits: readonly [number, number]
  className?: string
  children?: React.ReactNode
}) => (
  <span className={cn("relative h-full min-w-0 leading-8", className)}>
    <span className="block truncate">{children}</span>
    <ResizeHandle
      label={`Resize the ${name} column`}
      orientation="vertical"
      grows={edge === "right" ? 1 : -1}
      measure={() => width}
      limits={() => limits}
      control={control}
      // Centred in the gap between this column and the next.
      className={cn("absolute inset-y-0", edge === "right" ? "-right-[10px]" : "-left-[10px]")}
    />
  </span>
)

/** The uncommitted changes, as the first row of the history. */
const ChangesRow = ({ columns, count, selected, onSelect }: { columns: string; count: number; selected: boolean; onSelect: () => void }) => (
  <div
    role="row"
    aria-rowindex={0}
    aria-selected={selected}
    aria-label={`Uncommitted changes, ${count} ${count === 1 ? "file" : "files"}`}
    onClick={onSelect}
    className={cn(
      "absolute inset-x-0 top-0 grid cursor-default items-center gap-3",
      selected ? "bg-selection group-focus-visible/grid:shadow-[inset_2px_0_0_var(--ring)]" : "hover:bg-foreground/[0.05]",
    )}
    style={{ height: rowHeight, gridTemplateColumns: columns, paddingInline: listInset }}
  >
    <span role="gridcell" />
    <span role="gridcell" />
    <span role="gridcell" className="flex min-w-0 items-center gap-2">
      {/* The theme's yellow marks work in progress, rather than weight, with the usual "modified" asterisk. */}
      <Asterisk aria-hidden className="size-3 flex-none text-highlight" strokeWidth={2.5} />
      <span className="truncate text-foreground italic">Uncommitted changes</span>
      <span className="flex-none rounded bg-foreground/[0.07] px-1.5 text-[11px] leading-[18px] text-secondary-foreground tabular-nums">
        {count} {count === 1 ? "file" : "files"}
      </span>
    </span>
  </div>
)

/**
 * The uncommitted changes' node, hollow as not yet a commit, at the top of
 * the first lane, which the layout keeps for them down to the commit they
 * build on; the canvas draws that dashed line, and this joins it.
 */
const ChangesNode = ({ left, x, width, joinsFirstRow }: { left: number; x: number; width: number; joinsFirstRow: boolean }) => {
  if (x < 0 || x > width) return null
  const nodeY = rowHeight / 2
  const radius = 4
  // The first row's centre, or just clear of its ring when it is the commit built on.
  const end = rowHeight + rowHeight / 2 - (joinsFirstRow ? 7 : 0)
  // Started a whole number of dash patterns above the end, so its dashes run
  // on into the canvas's below.
  const period = uncommittedLine.dash[0] + uncommittedLine.dash[1]
  const start = end - Math.floor((end - nodeY - radius) / period) * period
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ left, width, height: end }}
      fill="none"
      stroke="var(--highlight)"
      strokeOpacity={uncommittedLine.strength}
      strokeWidth={uncommittedLine.width}
    >
      <line x1={x} x2={x} y1={start} y2={end} strokeDasharray={uncommittedLine.dash.join(" ")} />
      <circle cx={x} cy={nodeY} r={radius - 0.5} fill="var(--background)" />
    </svg>
  )
}

const copySha = (oid: string) =>
  void navigator.clipboard.writeText(oid).then(() => notify({ tone: "info", message: `Copied ${shortOid(oid)}`, duration: 1500 }))

/**
 * Follows a value without moving while scrolling: it grows once scrolling
 * pauses, shrinks by two or more once it has rested, and a new reset takes
 * the next value at once.
 */
const useRatchet = (value: number, { scrolling, resting, reset }: { scrolling: boolean; resting: boolean; reset: number }) => {
  const [settled, setSettled] = useState({ value, reset })
  const current = settled.reset === reset ? settled.value : 0
  useEffect(() => {
    const grow = value > current && (current === 0 || !scrolling)
    const shrink = value <= current - 2 && resting
    if (grow || shrink) setSettled({ value, reset })
  }, [value, current, scrolling, resting, reset])
  return current === 0 ? value : current
}

/** How long scrolling must pause before the reader is taken to be reading. */
const pauseAfter = 600
/** How long the list must rest before a wider graph than needed narrows. */
const restAfter = 1500

/** Whether an element has scrolled within the last idleAfter milliseconds. */
const useScrolling = (ref: React.RefObject<HTMLElement | null>, idleAfter: number) => {
  const [scrolling, setScrolling] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      setScrolling(true)
      clearTimeout(timer)
      timer = setTimeout(() => setScrolling(false), idleAfter)
    }
    element.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      clearTimeout(timer)
      element.removeEventListener("scroll", onScroll)
    }
  }, [ref])
  return scrolling
}

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
  readonly selected: boolean
  readonly anyEmphasis: boolean
  readonly refsById: ReadonlyMap<string, Ref>
  readonly worktreesById: ReadonlyMap<string, Worktree>
  readonly headRef: RefId | undefined
  readonly emphasized: RefId | undefined
  /** Where the branch and tag column ends, from the row's left edge. */
  readonly labelsEnd: number
  readonly dateFormat: Preferences["appearance"]["dateFormat"]
  readonly now: number
  readonly onSelect: (row: LoadedRow) => void
  readonly onMenuOpenChange: (open: boolean) => void
}

const CommitRow = memo(function CommitRow({
  index,
  top,
  loaded,
  columns,
  labelsEnd,
  showAuthor,
  selected,
  anyEmphasis,
  refsById,
  worktreesById,
  headRef,
  emphasized,
  dateFormat,
  now,
  onSelect,
  onMenuOpenChange,
}: CommitRowProps) {
  const style = { top, height: rowHeight, gridTemplateColumns: columns, paddingInline: listInset }
  if (!loaded) {
    return (
      <div role="row" aria-rowindex={index + 1} aria-busy className="absolute inset-x-0 grid items-center gap-3" style={style}>
        <span />
        <span className="size-2 rounded-full bg-foreground/[0.08]" style={{ marginLeft: gutter - 4 }} />
        <span className="h-2 w-1/2 rounded bg-foreground/[0.06]" />
        {showAuthor && <span className="h-2 w-3/5 rounded bg-foreground/[0.06]" />}
      </div>
    )
  }
  const { row, commit } = loaded
  const dim = anyEmphasis && !row.onEmphasized
  const badges = badgesFor(row.refIds, refsById, { head: headRef, emphasized })
  const meta = cn("truncate text-xs", dim && !selected ? "text-subtle-foreground" : "text-secondary-foreground")
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          aria-rowindex={index + 1}
          aria-selected={selected}
          aria-label={`${commit.subject}, ${commit.authorName}, ${formatFullDate(commit.authorTime)}, ${shortOid(row.oid)}`}
          onClick={() => onSelect(loaded)}
          className={cn(
            "group/row absolute inset-x-0 grid cursor-default items-center gap-3 data-[state=open]:shadow-[inset_0_0_0_1px_var(--ring)]",
            selected ? "bg-selection group-focus-visible/grid:shadow-[inset_2px_0_0_var(--ring)]" : "hover:bg-foreground/[0.05]",
          )}
          style={style}
        >
          {badges.length > 0 && (
            // A line from the labels to the commit's dot, under the graph,
            // which draws its lanes and the dot over it.
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 h-px"
              style={{
                left: labelsEnd,
                width: `clamp(${columnGap}px, calc(${columnGap + laneX(row.lane)}px - var(--graph-offset)), calc(${columnGap}px + var(--graph-width)))`,
                background: `color-mix(in srgb, ${laneColor(row.threadId)} 70%, transparent)`,
              }}
            />
          )}
          <span role="gridcell" className="flex min-w-0 items-center justify-end gap-1 overflow-hidden">
            {badges.length > 0 && (
              <>
                {badges.slice(0, maxBadges).map((badge, i) => (
                  <RefBadge
                    key={badge.ref.id}
                    badge={badge}
                    worktree={badge.ref.checkedOutInWorktreeId ? worktreesById.get(badge.ref.checkedOutInWorktreeId) : undefined}
                    thread={row.threadId}
                    dim={dim}
                    selected={selected}
                    primary={i === 0}
                  />
                ))}
                {badges.length > maxBadges && (
                  <span
                    className="flex h-[18px] flex-none items-center rounded bg-foreground/[0.06] px-1.5 text-[11px] text-secondary-foreground tabular-nums"
                    title={badges
                      .slice(maxBadges)
                      .map((badge) => badge.ref.shortName)
                      .join("\n")}
                  >
                    +{badges.length - maxBadges}
                  </span>
                )}
              </>
            )}
          </span>
          <span role="gridcell" />
          <span role="gridcell" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span
              className={cn("min-w-0 flex-1 truncate", !dim ? "text-foreground" : selected ? "text-secondary-foreground" : "text-subtle-foreground")}
              title={commit.subject}
            >
              {commit.subject}
            </span>
            {/* When and which commit, shown while the row is hovered; the details panel has them too. */}
            <span
              className="hidden flex-none text-xs text-secondary-foreground tabular-nums group-hover/row:inline"
              title={formatFullDate(commit.authorTime)}
            >
              {formatDate(commit.authorTime, dateFormat, now)} · <span className="font-mono">{shortOid(row.oid)}</span>
            </span>
          </span>
          {showAuthor && (
            <span role="gridcell" className={meta} title={commit.authorEmail}>
              {commit.authorName}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => copySha(row.oid)}>Copy SHA</ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(commit.subject)}>Copy subject</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
