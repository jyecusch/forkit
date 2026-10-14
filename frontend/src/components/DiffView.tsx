import { useVirtualizer } from "@tanstack/react-virtual"
import { Effect } from "effect"
import { ChevronDown, ChevronLeft, ChevronUp, Columns2, Rows2, Space } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useForkedEffect, usePreferences, useRun } from "@/app/hooks"
import { useLayoutSize } from "@/app/layoutSizes"
import { highlight } from "@/highlight/client"
import { syntaxStyles, tokenStride } from "@/highlight/styles"
import { shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import { wordDiff, type Range } from "@/lib/wordDiff"
import type { DiffHunk, DiffLayout, DiffLine, DiffRequest, FileDiff, Oid, RepoId } from "@/model/model.gen"
import { Preferences } from "@/services/Preferences"
import { Rpc } from "@/services/Rpc"
import { ResizeHandle } from "./ResizeHandle"

/** A file whose changes are shown, and where they come from. */
export interface DiffTarget {
  readonly request: DiffRequest
  /** Conflicted files have no single diff to show until they are resolved. */
  readonly conflicted: boolean
  /** The commit named in the header, when not the one diffed: a stash, whose untracked files are diffed in a commit of their own. */
  readonly shownOid?: Oid
}

export const sameDiff = (a: DiffTarget | undefined, b: DiffTarget | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.request.kind === b.request.kind &&
  a.request.path === b.request.path &&
  a.request.oid === b.request.oid &&
  a.request.worktreeId === b.request.worktreeId

interface DiffViewProps {
  readonly repo: RepoId
  readonly target: DiffTarget
  /** Changes whenever the worktree's files may have; a worktree diff reloads on it. */
  readonly revision: number
  /** Whether this repository is on screen, so its shortcuts apply. */
  readonly active: boolean
  readonly onClose: () => void
}

const lineHeight = 20
const hunkHeight = 28

/** A line and its place in the old or new file text, where its highlighting is found. */
interface Cell {
  readonly line: DiffLine
  readonly side: Side
  readonly index: number
}

/** Old for removed lines, new for added and unchanged ones. */
type Side = 0 | 1

type Row =
  | { readonly type: "hunk"; readonly hunk: DiffHunk }
  /** Unified: one line, old and new interleaved. */
  | { readonly type: "line"; readonly cell: Cell }
  /** Split: old on the left and new on the right; a side is empty opposite an addition or removal. */
  | { readonly type: "split"; readonly left: Cell | undefined; readonly right: Cell | undefined }
  | { readonly type: "truncated" }

/**
 * One file, whole, with its changes marked in place, shown instead of the
 * history. It opens at the first change, and the header and Option-arrows
 * move between changes.
 */
export const DiffView = ({ repo, target, revision, active, onClose }: DiffViewProps) => {
  const run = useRun()
  const ignoreWhitespace = usePreferences()?.diff.ignoreWhitespace ?? false
  const setIgnoreWhitespace = (ignore: boolean) =>
    void run(Preferences.use((preferences) => preferences.set("diff.ignoreWhitespace", ignore)))
  const layout = usePreferences()?.diff.layout ?? "unified"
  const setLayout = (next: DiffLayout) => {
    // Rows differ in height between layouts, so the line in view is kept rather than the scroll offset.
    const row = rows[anchorRow()]
    keepInView.current = row?.type === "line" ? row.cell.line : row?.type === "split" ? (row.right ?? row.left)?.line : undefined
    void run(Preferences.use((preferences) => preferences.set("diff.layout", next)))
  }
  const keepInView = useRef<DiffLine>(undefined)
  const split = layout === "split"
  const request: DiffRequest = { ...target.request, ignoreWhitespace }
  const [loaded, setLoaded] = useState<{ readonly target: DiffTarget; readonly diff: FileDiff }>()
  const [failed, setFailed] = useState<string>()
  const reloadOn = request.kind === "commit" ? 0 : revision
  useForkedEffect(
    () =>
      target.conflicted
        ? Effect.void
        : Effect.sync(() => setFailed(undefined)).pipe(
            Effect.andThen(Rpc.use((rpc) => rpc.diff(repo, request))),
            Effect.tap((diff) => Effect.sync(() => setLoaded({ target, diff }))),
            Effect.tapError((error) => Effect.sync(() => setFailed(error.message))),
            Effect.ignore,
          ),
    [repo, request.kind, request.oid, request.worktreeId, request.path, request.oldPath, ignoreWhitespace, target.conflicted, reloadOn],
  )
  // A reload keeps showing the previous diff of the same file until it arrives.
  const diff = sameDiff(loaded?.target, target) ? loaded?.diff : undefined

  const scrollRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  // The old side's share of a side-by-side diff.
  const splitShare = useLayoutSize("diffSplit")

  const laidOut = useMemo(() => flatten(diff), [diff])
  const { texts } = laidOut
  const rows = split ? laidOut.split : laidOut.unified

  // What changed within each edited line, worked out as lines come on screen
  // and kept per removed line, its pair's key.
  const wordChanges = useMemo(() => {
    const cache = new Map<Cell, ReturnType<typeof wordDiff>>()
    return (cell: Cell | undefined): ReadonlyArray<Range> | undefined => {
      const pair = cell && laidOut.pairs.get(cell)
      if (!cell || !pair) return undefined
      const removed = cell.side === 0 ? cell : pair
      let diff = cache.get(removed)
      if (diff === undefined) {
        diff = wordDiff(removed.line.text, (removed === cell ? pair : cell).line.text, ignoreWhitespace)
        cache.set(removed, diff)
      }
      return diff ? (cell === removed ? diff.before : diff.after) : undefined
    }
  }, [laidOut, ignoreWhitespace])

  // Highlighting arrives after the plain text, from a worker.
  const [highlighted, setHighlighted] = useState<{ readonly texts: unknown; readonly sides: ReadonlyArray<LineTokens> }>()
  useEffect(() => {
    if (!diff || diff.binary) return
    let current = true
    void highlight(request.path, texts).then((sides) => {
      if (current && sides) setHighlighted({ texts, sides: sides.map(indexByLine) })
    })
    return () => {
      current = false
    }
  }, [diff, texts, request.path])
  const sides = highlighted?.texts === texts ? highlighted.sides : undefined
  const tokensOf = (cell: Cell | undefined) => cell && sides?.[cell.side]?.(cell.index)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "hunk" ? hunkHeight : lineHeight),
    overscan: 30,
  })
  useEffect(() => virtualizer.measure(), [rows, virtualizer])
  const { gutter, width } = useMemo(() => measure(diff), [diff])
  const stats = useMemo(() => count(diff), [diff])
  const blocks = useMemo(() => changeBlocks(rows), [rows])
  const changes = useMemo(() => blocks.map((block) => block.start), [blocks])

  // Scrolls a row to a third of the way down, with context above it. Rows
  // measured as they come into view can move it, so it is checked and
  // corrected over the next few frames until it settles.
  const third = () => (scrollRef.current?.clientHeight ?? 0) / 3
  const settling = useRef(0)
  // Scrolling caused by moving to a change, rather than by hand, until then.
  const navigatingUntil = useRef(0)
  const reveal = (row: number) => {
    cancelAnimationFrame(settling.current)
    let frames = 0
    const place = () => {
      navigatingUntil.current = performance.now() + 250
      const element = scrollRef.current
      const start = virtualizer.measurementsCache[row]?.start ?? row * lineHeight
      const target = Math.max(start - third(), 0)
      if (element && Math.abs(element.scrollTop - target) > 1) virtualizer.scrollToOffset(target)
      if (++frames < 8) settling.current = requestAnimationFrame(place)
    }
    place()
  }
  // The row at an offset, from the rows as drawn.
  const rowAt = (offset: number) =>
    virtualizer.getVirtualItems().find((item) => item.start <= offset && offset < item.end)?.index ??
    virtualizer.getVirtualItemForOffset(offset)?.index ??
    0
  // Changes are counted from the row a third of the way down. The browser
  // rounds scroll positions, so a revealed row can sit a fraction above it.
  const anchorRow = () => rowAt((scrollRef.current?.scrollTop ?? 0) + third() + 2)
  // How many changes start at or above the anchor, for "2 of 7". At the
  // bottom of the file the last changes cannot reach the anchor, so every
  // change on screen counts.
  const scroller = scrollRef.current
  const atEnd = scroller !== null && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
  const anchor = !diff
    ? 0
    : atEnd
      ? rowAt(scroller.scrollTop + scroller.clientHeight - 1)
      : anchorRow()
  const passed = changes.filter((row) => row <= anchor).length

  // The change last moved to with the arrows or the ruler. It is tracked
  // rather than worked out from the scroll position, because changes near
  // the top or bottom of a file cannot scroll to the anchor. Scrolling by
  // hand hands back to the scroll position.
  const [moved, setMoved] = useState<number>()
  // At the very top, the first change on screen is the current one.
  const atTop = scroller !== null && scroller.scrollTop <= 1 && !atEnd
  const firstOnScreen = changes.length > 0 && scroller !== null && changes[0]! <= rowAt(scroller.clientHeight - 1)
  const fromScroll = atTop ? (firstOnScreen ? 0 : -1) : passed - 1
  const current = moved !== undefined && moved < changes.length ? moved : fromScroll
  const moveTo = (index: number) => {
    setMoved(index)
    reveal(changes[index]!)
  }
  const onUserScroll = () => {
    if (moved !== undefined && performance.now() > navigatingUntil.current) setMoved(undefined)
  }

  const scrollToFraction = (fraction: number) => {
    const element = scrollRef.current
    if (!element) return
    virtualizer.scrollToOffset(Math.max(fraction * virtualizer.getTotalSize() - element.clientHeight / 2, 0))
  }

  const step = (direction: 1 | -1) => {
    const next = current + direction
    if (next >= 0 && next < changes.length) moveTo(next)
  }

  // After a layout switch, the line that was in view is brought back to the same place.
  useEffect(() => {
    const line = keepInView.current
    if (!line) return
    keepInView.current = undefined
    const index = rows.findIndex((row) =>
      row.type === "line" ? row.cell.line === line : row.type === "split" && (row.left?.line === line || row.right?.line === line),
    )
    if (index >= 0) reveal(index)
  }, [rows])

  // A newly opened file starts at its first change; a reload stays put.
  const revealed = useRef<DiffTarget>(undefined)
  useEffect(() => {
    if (!diff || sameDiff(revealed.current, target)) return
    revealed.current = target
    if (changes[0] !== undefined) moveTo(0)
  })

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return
      event.preventDefault()
      step(event.key === "ArrowDown" ? 1 : -1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const message: React.ReactNode = target.conflicted ? (
    "This file has conflicts. Resolve them, and its changes appear here."
  ) : failed && !diff ? (
    failed
  ) : diff?.binary ? (
    "Binary file, not shown"
  ) : diff && diff.hunks.length === 0 && ignoreWhitespace ? (
    <>
      Only whitespace changed.
      <button className="ml-1.5 font-medium text-primary hover:underline" onClick={() => setIgnoreWhitespace(false)}>
        Show whitespace changes
      </button>
    </>
  ) : diff && diff.hunks.length === 0 ? (
    "No changes to its content"
  ) : undefined

  return (
    <section aria-label={`Changes to ${request.path}`} className="absolute inset-0 z-10 flex flex-col bg-background">
      <header className="flex h-8 flex-none items-center gap-2 border-b pr-3 pl-1.5 text-xs">
        <button
          aria-label="Back to history"
          title="Back to history (Esc)"
          onClick={onClose}
          className="flex size-6 flex-none items-center justify-center rounded-md text-subtle-foreground hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <PathLabel path={request.path} oldPath={request.oldPath} />
        <span className="flex-none rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] text-secondary-foreground">
          {request.kind === "commit" && request.oid ? <span className="font-mono">{shortOid(target.shownOid ?? request.oid)}</span> : kindLabels[request.kind]}
        </span>
        {diff && !diff.binary && (
          <span className="ml-auto flex flex-none items-center gap-3">
            <span role="radiogroup" aria-label="Layout" className="flex rounded-md bg-foreground/[0.05] p-0.5">
              {(["unified", "split"] as const).map((option) => (
                <button
                  key={option}
                  role="radio"
                  aria-checked={layout === option}
                  aria-label={option === "unified" ? "Unified" : "Side by side"}
                  title={option === "unified" ? "Unified" : "Side by side"}
                  onClick={() => setLayout(option)}
                  className={cn(
                    "flex size-5 items-center justify-center rounded-[4px]",
                    layout === option ? "bg-background text-foreground shadow-sm" : "text-subtle-foreground hover:text-foreground",
                  )}
                >
                  {option === "unified" ? <Rows2 className="size-3.5" /> : <Columns2 className="size-3.5" />}
                </button>
              ))}
            </span>
            <button
              aria-label="Ignore whitespace"
              aria-pressed={ignoreWhitespace}
              title={ignoreWhitespace ? "Showing changes other than whitespace" : "Ignore changes to whitespace"}
              onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
              className={cn(navButton, ignoreWhitespace && "bg-foreground/[0.08] text-foreground")}
            >
              <Space className="size-4" />
            </button>
            <span className="flex gap-2 font-mono text-[11px] tabular-nums">
              <span className="text-success">+{stats.added}</span>
              <span className="text-destructive">−{stats.removed}</span>
            </span>
            {changes.length > 0 && (
              <span className="-mr-1.5 flex items-center">
                <span className="mr-1 text-subtle-foreground tabular-nums">
                  {current >= 0 ? `${current + 1} of ${changes.length}` : `${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
                </span>
                <button aria-label="Previous change" title="Previous change (⌥↑)" onClick={() => step(-1)} className={navButton}>
                  <ChevronUp className="size-4" />
                </button>
                <button aria-label="Next change" title="Next change (⌥↓)" onClick={() => step(1)} className={navButton}>
                  <ChevronDown className="size-4" />
                </button>
              </span>
            )}
          </span>
        )}
      </header>
      {message ? (
        <p className="flex flex-1 items-center justify-center p-6 text-center text-subtle-foreground">{message}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            ref={paneRef}
            className="relative flex min-w-0 flex-1"
            style={{ "--diff-split": `${(splitShare.size ?? 0.5) * 100}%` } as React.CSSProperties}
          >
            <div
              ref={scrollRef}
              onScroll={onUserScroll}
              tabIndex={0}
              aria-busy={!diff}
              className={cn(
                "relative min-w-0 flex-1 overflow-auto font-mono text-xs outline-none select-text [tab-size:4]",
                // The overview ruler is the vertical scrollbar; long lines keep a slim horizontal one.
                "[&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar-corner]:bg-transparent",
                "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/15",
              )}
            >
              <div className="relative" style={{ height: virtualizer.getTotalSize(), minWidth: split ? "100%" : `max(100%, ${width})` }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index]!
                  return (
                    <div
                      key={item.key}
                      // Split lines wrap, so their rows are measured; unified rows are one line each.
                      ref={split ? virtualizer.measureElement : undefined}
                      data-index={item.index}
                      className="absolute inset-x-0"
                      style={{ top: item.start, height: split && row.type === "split" ? undefined : item.size }}
                    >
                      {row.type === "hunk" ? (
                        <HunkHeader hunk={row.hunk} />
                      ) : row.type === "line" ? (
                        <Line line={row.cell.line} gutter={gutter} tokens={tokensOf(row.cell)} changed={wordChanges(row.cell)} />
                      ) : row.type === "split" ? (
                        <div className="grid min-h-5 grid-cols-[minmax(0,var(--diff-split))_minmax(0,1fr)] divide-x divide-border/60">
                          <SplitCell cell={row.left} gutter={gutter} tokens={tokensOf(row.left)} changed={wordChanges(row.left)} />
                          <SplitCell cell={row.right} gutter={gutter} tokens={tokensOf(row.right)} changed={wordChanges(row.right)} />
                        </div>
                      ) : (
                        <p className="flex h-full items-center px-3 font-sans text-subtle-foreground">
                          The rest of this file's changes are too long to show.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            {split && (
              <ResizeHandle
                label="Resize the old and new sides"
                orientation="vertical"
                grows={1}
                measure={() => (splitShare.size ?? 0.5) * (paneRef.current?.offsetWidth ?? 0)}
                limits={() => [0.2 * (paneRef.current?.offsetWidth ?? 0), 0.8 * (paneRef.current?.offsetWidth ?? 0)]}
                toSize={(px) => px / (paneRef.current?.offsetWidth || 1)}
                control={splitShare}
                className="absolute inset-y-0 left-[var(--diff-split)] -translate-x-1/2"
              />
            )}
          </div>
          {diff && rows.length > 0 && (
            <OverviewRuler
              blocks={blocks}
              rows={rows.length}
              viewTop={(virtualizer.scrollOffset ?? 0) / Math.max(virtualizer.getTotalSize(), 1)}
              viewHeight={(scrollRef.current?.clientHeight ?? 0) / Math.max(virtualizer.getTotalSize(), 1)}
              onJump={(row) => moveTo(changes.indexOf(row))}
              onScrollTo={scrollToFraction}
            />
          )}
        </div>
      )}
    </section>
  )
}

const navButton =
  "flex size-6 items-center justify-center rounded-md text-subtle-foreground hover:bg-foreground/[0.05] hover:text-foreground"

const kindLabels: Record<DiffRequest["kind"], string> = {
  commit: "Commit",
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
}

const PathLabel = ({ path, oldPath }: { path: string; oldPath: string | undefined }) => {
  const slash = path.lastIndexOf("/")
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" title={oldPath ? `${oldPath} → ${path}` : path}>
      <span className="truncate font-medium text-foreground">{path.slice(slash + 1)}</span>
      {slash >= 0 && <span className="min-w-0 truncate text-subtle-foreground">{path.slice(0, slash)}</span>}
    </span>
  )
}

const HunkHeader = ({ hunk }: { hunk: DiffHunk }) => (
  <div className="flex h-full items-center gap-3 border-y border-border/60 bg-foreground/[0.03] px-3 text-subtle-foreground">
    <span>
      @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
    </span>
    {hunk.section && <span className="truncate font-sans text-secondary-foreground">{hunk.section}</span>}
  </div>
)

const lineTones: Record<DiffLine["kind"], { row: string; marker: string; symbol: string }> = {
  context: { row: "", marker: "text-subtle-foreground", symbol: " " },
  added: { row: "bg-success/10", marker: "text-success", symbol: "+" },
  removed: { row: "bg-destructive/10", marker: "text-destructive", symbol: "−" },
}

interface LineProps {
  readonly line: DiffLine
  readonly gutter: string
  readonly tokens: Int32Array | undefined
  /** The parts of an edited line that changed, marked more strongly than the line. */
  readonly changed: ReadonlyArray<Range> | undefined
}

const Line = ({ line, gutter, tokens, changed }: LineProps) => {
  const tone = lineTones[line.kind]
  return (
    <div className={cn("flex h-full items-center pl-1 whitespace-pre", tone.row)}>
      <span className="flex-none pr-2 text-right text-muted-foreground tabular-nums select-none" style={{ width: gutter }}>
        {line.oldLine ?? ""}
      </span>
      <span className="flex-none pr-2 text-right text-muted-foreground tabular-nums select-none" style={{ width: gutter }}>
        {line.newLine ?? ""}
      </span>
      <span aria-hidden className={cn("w-4 flex-none text-center select-none", tone.marker)}>
        {tone.symbol}
      </span>
      <span className="pr-4 text-foreground">{paint(line.text, tokens, changed, changedTones[line.kind])}</span>
      {line.noNewline && (
        <span title="No newline at end of file" className="ml-1 font-sans text-[11px] text-subtle-foreground select-none">
          no newline at end
        </span>
      )}
    </div>
  )
}

/** One side of a split row: a line number, its marker and its text, wrapped to fit. */
const SplitCell = ({ cell, gutter, tokens, changed }: Omit<LineProps, "line"> & { readonly cell: Cell | undefined }) => {
  if (!cell) return <div aria-hidden className="bg-foreground/[0.025]" />
  const { line } = cell
  const tone = lineTones[line.kind]
  return (
    <div className={cn("flex min-w-0 items-start pl-1", tone.row)}>
      <span className="flex-none pr-2 text-right leading-5 text-muted-foreground tabular-nums select-none" style={{ width: gutter }}>
        {cell.side === 0 ? line.oldLine : line.newLine}
      </span>
      <span aria-hidden className={cn("w-4 flex-none text-center leading-5 select-none", tone.marker)}>
        {tone.symbol}
      </span>
      <span className="min-w-0 flex-1 pr-3 leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
        {paint(line.text, tokens, changed, changedTones[line.kind])}
        {line.noNewline && (
          <span title="No newline at end of file" className="ml-1 font-sans text-[11px] text-subtle-foreground select-none">
            no newline at end
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * Lays the diff out both ways, unified and split, and rebuilds the old and
 * new file texts so each can be highlighted whole. Removed and added lines
 * in one change are paired in order, as edits of each other, so their
 * changed words can be marked and, split, set side by side.
 */
const flatten = (diff: FileDiff | undefined) => {
  const unified: Array<Row> = []
  const split: Array<Row> = []
  const pairs = new Map<Cell, Cell>()
  const old: Array<string> = []
  const next: Array<string> = []
  if (!diff) return { unified, split, pairs, texts: ["", ""] as [string, string] }

  let removed: Array<Cell> = []
  let added: Array<Cell> = []
  const closeRun = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const [left, right] = [removed[k], added[k]]
      if (left && right) {
        pairs.set(left, right)
        pairs.set(right, left)
      }
      split.push({ type: "split", left, right })
    }
    removed = []
    added = []
  }
  // The whole file comes back as one hunk, whose header says nothing new.
  const headers = diff.hunks.length > 1
  for (const hunk of diff.hunks) {
    if (headers) {
      unified.push({ type: "hunk", hunk })
      split.push({ type: "hunk", hunk })
    }
    for (const line of hunk.lines) {
      if (line.kind === "context" || (line.kind === "removed" && added.length > 0)) closeRun()
      if (line.kind === "removed") {
        const cell: Cell = { line, side: 0, index: old.length }
        old.push(line.text)
        removed.push(cell)
        unified.push({ type: "line", cell })
      } else if (line.kind === "added") {
        const cell: Cell = { line, side: 1, index: next.length }
        next.push(line.text)
        added.push(cell)
        unified.push({ type: "line", cell })
      } else {
        const left: Cell = { line, side: 0, index: old.length }
        const right: Cell = { line, side: 1, index: next.length }
        old.push(line.text)
        next.push(line.text)
        unified.push({ type: "line", cell: right })
        split.push({ type: "split", left, right })
      }
    }
    closeRun()
  }
  if (diff.truncated) {
    unified.push({ type: "truncated" })
    split.push({ type: "truncated" })
  }
  return { unified, split, pairs, texts: [old.join("\n"), next.join("\n")] as [string, string] }
}

/** Finds the tokens of one line of highlighted text. */
type LineTokens = (line: number) => Int32Array | undefined

/** Indexes [line, from, to, style] quads, which arrive in line order, by line. */
const indexByLine = (tokens: Int32Array): LineTokens => {
  const starts = new Map<number, [number, number]>()
  for (let i = 0; i < tokens.length; i += tokenStride) {
    const line = tokens[i]!
    const range = starts.get(line)
    if (range) range[1] = i + tokenStride
    else starts.set(line, [i, i + tokenStride])
  }
  return (line) => {
    const range = starts.get(line)
    return range && tokens.subarray(range[0], range[1])
  }
}

const changedTones: Record<DiffLine["kind"], string> = {
  context: "",
  added: "rounded-[2px] bg-success/30",
  removed: "rounded-[2px] bg-destructive/30",
}

/**
 * Splits a line at every boundary of its highlighted tokens and its changed
 * ranges, so each piece carries its syntax colour and, if it changed, a mark.
 */
const paint = (text: string, tokens: Int32Array | undefined, changed: ReadonlyArray<Range> | undefined, changedClass: string) => {
  if (!tokens?.length && !changed?.length) return text
  const cuts = new Set([0, text.length])
  for (let i = 0; tokens && i < tokens.length; i += tokenStride) cuts.add(tokens[i + 1]!).add(tokens[i + 2]!)
  for (const [from, to] of changed ?? []) cuts.add(from).add(to)
  const points = [...cuts].sort((a, b) => a - b)

  const parts: Array<React.ReactNode> = []
  let token = 0
  let range = 0
  for (let p = 0; p + 1 < points.length; p++) {
    const [from, to] = [points[p]!, points[p + 1]!]
    if (from === to) continue
    while (tokens && token < tokens.length && tokens[token + 2]! <= from) token += tokenStride
    while (changed && range < changed.length && changed[range]![1] <= from) range++
    const style = tokens && token < tokens.length && tokens[token + 1]! <= from ? `syn-${syntaxStyles[tokens[token + 3]!]}` : ""
    const isChanged = changed !== undefined && range < changed.length && changed[range]![0] <= from
    const className = cn(style, isChanged && changedClass)
    parts.push(className ? <span key={from} className={className}>{text.slice(from, to)}</span> : text.slice(from, to))
  }
  return parts
}

/** A run of changed lines: where it starts and ends, and what it changes. */
interface ChangeBlock {
  readonly start: number
  end: number
  added: boolean
  removed: boolean
}

const changeBlocks = (rows: ReadonlyArray<Row>) => {
  const blocks: Array<ChangeBlock> = []
  let current: ChangeBlock | undefined
  rows.forEach((row, index) => {
    const kinds =
      row.type === "line" ? [row.cell.line.kind] : row.type === "split" ? [row.left?.line.kind, row.right?.line.kind] : []
    const isAdded = kinds.includes("added")
    const isRemoved = kinds.includes("removed")
    if (!isAdded && !isRemoved) {
      current = undefined
      return
    }
    if (!current) {
      current = { start: index, end: index, added: false, removed: false }
      blocks.push(current)
    }
    current.end = index
    current.added ||= isAdded
    current.removed ||= isRemoved
  })
  return blocks
}

interface OverviewRulerProps {
  readonly blocks: ReadonlyArray<ChangeBlock>
  readonly rows: number
  /** The visible part of the file, as fractions of its height. */
  readonly viewTop: number
  readonly viewHeight: number
  readonly onJump: (row: number) => void
  readonly onScrollTo: (fraction: number) => void
}

/**
 * The whole file in a strip beside the diff, which is also its scrollbar: a
 * mark for every change and a thumb for the part on screen. Clicking a mark
 * jumps to that change; clicking or dragging anywhere else scrolls there.
 */
const OverviewRuler = ({ blocks, rows, viewTop, viewHeight, onJump, onScrollTo }: OverviewRulerProps) => {
  const fractionAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
  }
  return (
    <div
      aria-hidden
      className="relative w-4 flex-none cursor-pointer border-l bg-foreground/[0.02] select-none"
      onPointerDown={(event) => {
        const mark = (event.target as HTMLElement).dataset.row
        if (mark !== undefined) {
          onJump(Number(mark))
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        onScrollTo(fractionAt(event))
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onScrollTo(fractionAt(event))
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-px rounded-[3px] bg-foreground/[0.12]"
        style={{ top: `${viewTop * 100}%`, height: `max(${viewHeight * 100}%, 12px)` }}
      />
      {blocks.map((block) => (
        <div
          key={block.start}
          data-row={block.start}
          className="absolute inset-x-[3px] flex min-h-[3px] overflow-hidden rounded-[1px]"
          style={{ top: `${(block.start / rows) * 100}%`, height: `${((block.end - block.start + 1) / rows) * 100}%` }}
        >
          {block.removed && <span data-row={block.start} className="flex-1 bg-destructive" />}
          {block.added && <span data-row={block.start} className="flex-1 bg-success" />}
        </div>
      ))}
    </div>
  )
}

/** The line-number column width and the width the longest line needs. */
const measure = (diff: FileDiff | undefined) => {
  let widest = 0
  let largest = 0
  for (const hunk of diff?.hunks ?? []) {
    largest = Math.max(largest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)
    for (const line of hunk.lines) {
      // Tabs are drawn four wide.
      widest = Math.max(widest, line.text.length + 3 * (line.text.split("\t").length - 1))
    }
  }
  const digits = Math.max(String(largest).length, 3)
  const gutter = `calc(${digits}ch + 1rem)`
  return { gutter, width: `calc(2 * (${gutter}) + 1rem + ${widest}ch + 2rem)` }
}

const count = (diff: FileDiff | undefined) => {
  let added = 0
  let removed = 0
  for (const hunk of diff?.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.kind === "added") added++
      if (line.kind === "removed") removed++
    }
  }
  return { added, removed }
}
