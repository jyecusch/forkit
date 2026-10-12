import { useVirtualizer } from "@tanstack/react-virtual"
import { Effect } from "effect"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useForkedEffect, useResolvedTheme } from "@/app/hooks"
import { useService } from "@/app/services"
import { layoutColumns, listInset } from "@/graph/columns"
import { drawGraph, readPalette, type GraphPalette } from "@/graph/draw"
import { geometry, gutter, laneWidth, laneX, rowHeight, widestLane } from "@/graph/geometry"
import { notify } from "@/app/notifications"
import { useNow } from "@/app/useNow"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { badgesFor } from "@/lib/badges"
import { formatDate, formatFullDate, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GraphView, Preferences, Ref, RefId, RepoId } from "@/model/model.gen"
import { GraphData, type LoadedRow } from "@/services/GraphData"
import { focusIsLost } from "./Chrome"
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
  /** The active worktree's checked-out commit: ringed, and selected until the user picks one. */
  readonly activeHead: string | undefined
  readonly onSelect: (row: LoadedRow) => void
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

  const virtualizer = useVirtualizer({
    count: view.totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
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
    if (!scrollRequest || scrollRequest.row < 0) return
    const top = Math.max(scrollRequest.row * rowHeight - (virtualizer.scrollRect?.height ?? 0) / 2 + rowHeight / 2, 0)
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
  const columns = layoutColumns(paneWidth, lanes)
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

  const canvasTop = first * rowHeight
  useLayoutEffect(() => {
    const context = canvasRef.current?.getContext("2d")
    if (!context || !palette || !active) return
    context.clearRect(0, 0, columns.graph, canvasHeight)
    drawGraph(
      context,
      geometry({
        first,
        last: Math.min(first + canvasRows, view.totalRows - 1),
        originY: canvasTop,
        offsetX: clampedOffsetX,
        rowAt: (index) => graphData.peek(repo, index),
        activeHead: props.activeHead,
        headOids: props.headOids,
        anyEmphasis: emphasized !== undefined,
      }),
      palette,
      {
        dimmedStrength: preferences.graph.dimmedOpacity,
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
    emphasized,
    props.headOids,
    props.activeHead,
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
  const pageRows = Math.max(Math.floor(viewportHeight / rowHeight) - 1, 1)
  const onKeyDown = (event: KeyboardEvent) => {
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
        <span />
        <span>Description</span>
        {columns.showAuthor && <span>Author</span>}
        {columns.showDate && <span>Date</span>}
        {columns.showCommit && <span>SHA</span>}
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
        <div className="relative overflow-hidden" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => (
            <CommitRow
              key={item.key}
              index={item.index}
              top={item.start}
              loaded={graphData.peek(repo, item.index)}
              columns={columns.template}
              showAuthor={columns.showAuthor}
              showDate={columns.showDate}
              showCommit={columns.showCommit}
              selected={selectedOid !== undefined && graphData.peek(repo, item.index)?.row.oid === selectedOid}
              anyEmphasis={emphasized !== undefined}
              refsById={props.refsById}
              headRef={props.headRef}
              emphasized={emphasized}
              dateFormat={preferences.appearance.dateFormat}
              now={now}
              onSelect={onSelect}
              onMenuOpenChange={onMenuOpenChange}
            />
          ))}
          <canvas
            ref={canvasRef}
            aria-hidden
            className="pointer-events-none absolute"
            style={{ top: canvasTop, left: listInset, width: columns.graph, height: canvasHeight }}
          />
        </div>
      </div>
    </section>
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
  readonly showDate: boolean
  readonly showCommit: boolean
  readonly selected: boolean
  readonly anyEmphasis: boolean
  readonly refsById: ReadonlyMap<string, Ref>
  readonly headRef: RefId | undefined
  readonly emphasized: RefId | undefined
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
  showAuthor,
  showDate,
  showCommit,
  selected,
  anyEmphasis,
  refsById,
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
        <span className="size-2 rounded-full bg-foreground/[0.08]" style={{ marginLeft: gutter - 4 }} />
        <span className="h-2 w-1/2 rounded bg-foreground/[0.06]" />
        {showAuthor && <span className="h-2 w-3/5 rounded bg-foreground/[0.06]" />}
        {showDate && <span className="h-2 w-3/4 rounded bg-foreground/[0.06]" />}
        {showCommit && <span className="h-2 w-4/5 rounded bg-foreground/[0.06]" />}
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
          aria-label={`${commit.subject}, ${commit.authorName}, ${shortOid(row.oid)}`}
          onClick={() => onSelect(loaded)}
          className={cn(
            "absolute inset-x-0 grid cursor-default items-center gap-3 data-[state=open]:shadow-[inset_0_0_0_1px_var(--ring)]",
            selected ? "bg-selection group-focus-visible/grid:shadow-[inset_2px_0_0_var(--ring)]" : "hover:bg-foreground/[0.05]",
          )}
          style={style}
        >
          <span role="gridcell" />
          <span role="gridcell" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {badges.length > 0 && (
              <span className="flex max-w-[60%] min-w-0 flex-none items-center gap-1 overflow-hidden">
                {badges.slice(0, maxBadges).map((badge, i) => (
                  <RefBadge key={badge.ref.id} badge={badge} thread={row.threadId} dim={dim} selected={selected} primary={i === 0} />
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
              </span>
            )}
            <span
              className={cn("min-w-0 flex-1 truncate", !dim ? "text-foreground" : selected ? "text-secondary-foreground" : "text-subtle-foreground")}
              title={commit.subject}
            >
              {commit.subject}
            </span>
          </span>
          {showAuthor && (
            <span role="gridcell" className={meta} title={commit.authorEmail}>
              {commit.authorName}
            </span>
          )}
          {showDate && (
            <span role="gridcell" className={meta} title={formatFullDate(commit.authorTime)}>
              {formatDate(commit.authorTime, dateFormat, now)}
            </span>
          )}
          {showCommit && (
            <span role="gridcell" className={cn("font-mono text-xs", dim && !selected ? "text-subtle-foreground" : "text-secondary-foreground")}>
              {shortOid(row.oid)}
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
