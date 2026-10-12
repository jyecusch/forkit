import { useVirtualizer } from "@tanstack/react-virtual"
import { Effect } from "effect"
import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useForkedEffect } from "@/app/hooks"
import { highlight } from "@/highlight/client"
import { syntaxStyles, tokenStride } from "@/highlight/styles"
import { shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import { wordDiff, type Range } from "@/lib/wordDiff"
import type { DiffHunk, DiffLine, DiffRequest, FileDiff, RepoId } from "@/model/model.gen"
import { Rpc } from "@/services/Rpc"

/** A file whose changes are shown, and where they come from. */
export interface DiffTarget {
  readonly request: DiffRequest
  /** Conflicted files have no single diff to show until they are resolved. */
  readonly conflicted: boolean
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

type Row =
  | { readonly type: "hunk"; readonly hunk: DiffHunk }
  | {
      readonly type: "line"
      readonly line: DiffLine
      /** The line's place in the old or new file text, to find its highlighting. */
      readonly side: Side
      readonly index: number
    }
  | { readonly type: "truncated" }

/** Old for removed lines, new for added and unchanged ones. */
type Side = 0 | 1

/**
 * One file, whole, with its changes marked in place, shown instead of the
 * history. It opens at the first change, and the header and Option-arrows
 * move between changes.
 */
export const DiffView = ({ repo, target, revision, active, onClose }: DiffViewProps) => {
  const { request } = target
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
    [repo, request.kind, request.oid, request.worktreeId, request.path, request.oldPath, target.conflicted, reloadOn],
  )
  // A reload keeps showing the previous diff of the same file until it arrives.
  const diff = sameDiff(loaded?.target, target) ? loaded?.diff : undefined

  const scrollRef = useRef<HTMLDivElement>(null)

  const { rows, texts, partners } = useMemo(() => flatten(diff), [diff])

  // What changed within each edited line, worked out as lines come on screen.
  const wordChanges = useMemo(() => {
    const cache = new Map<number, ReturnType<typeof wordDiff>>()
    return (row: number): ReadonlyArray<Range> | undefined => {
      const partner = partners[row]!
      if (partner < 0) return undefined
      const removed = Math.min(row, partner)
      let diff = cache.get(removed)
      if (diff === undefined) {
        const [before, after] = [rows[removed], rows[Math.max(row, partner)]]
        diff = before?.type === "line" && after?.type === "line" ? wordDiff(before.line.text, after.line.text) : null
        cache.set(removed, diff)
      }
      return diff ? (row === removed ? diff.before : diff.after) : undefined
    }
  }, [rows, partners])

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
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "line" ? lineHeight : hunkHeight),
    overscan: 30,
  })
  useEffect(() => virtualizer.measure(), [rows, virtualizer])
  const { gutter, width } = useMemo(() => measure(diff), [diff])
  const stats = useMemo(() => count(diff), [diff])
  const blocks = useMemo(() => changeBlocks(rows), [rows])
  const changes = useMemo(() => blocks.map((block) => block.start), [blocks])

  // Scrolls a change to a third of the way down, with context above it.
  const third = () => (scrollRef.current?.clientHeight ?? 0) / 3
  const reveal = (row: number) => {
    const start = virtualizer.measurementsCache[row]?.start ?? row * lineHeight
    virtualizer.scrollToOffset(Math.max(start - third(), 0))
  }
  // Changes are counted from the row a third of the way down.
  const anchorRow = () => virtualizer.getVirtualItemForOffset((virtualizer.scrollOffset ?? 0) + third())?.index ?? 0
  // How many changes start at or above the anchor, for "2 of 7".
  const anchor = diff ? anchorRow() : 0
  const passed = changes.filter((row) => row <= anchor).length

  const scrollToFraction = (fraction: number) => {
    const element = scrollRef.current
    if (!element) return
    virtualizer.scrollToOffset(Math.max(fraction * virtualizer.getTotalSize() - element.clientHeight / 2, 0))
  }

  const step = (direction: 1 | -1) => {
    const anchor = anchorRow()
    const next =
      direction === 1 ? changes.find((row) => row > anchor) : [...changes].reverse().find((row) => row < anchor)
    if (next !== undefined) reveal(next)
  }

  // A newly opened file starts at its first change; a reload stays put.
  const revealed = useRef<DiffTarget>(undefined)
  useEffect(() => {
    if (!diff || sameDiff(revealed.current, target)) return
    revealed.current = target
    if (changes[0] !== undefined) reveal(changes[0])
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

  const message = target.conflicted
    ? "This file has conflicts. Resolve them, and its changes appear here."
    : failed && !diff
      ? failed
      : diff?.binary
        ? "Binary file, not shown"
        : diff && diff.hunks.length === 0
          ? "No changes to its content"
          : undefined

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
          {request.kind === "commit" && request.oid ? <span className="font-mono">{shortOid(request.oid)}</span> : kindLabels[request.kind]}
        </span>
        {diff && !diff.binary && (
          <span className="ml-auto flex flex-none items-center gap-3">
            <span className="flex gap-2 font-mono text-[11px] tabular-nums">
              <span className="text-success">+{stats.added}</span>
              <span className="text-destructive">−{stats.removed}</span>
            </span>
            {changes.length > 0 && (
              <span className="-mr-1.5 flex items-center">
                <span className="mr-1 text-subtle-foreground tabular-nums">
                  {passed > 0 ? `${passed} of ${changes.length}` : `${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
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
            ref={scrollRef}
            tabIndex={0}
            aria-busy={!diff}
            className={cn(
              "relative min-w-0 flex-1 overflow-auto font-mono text-xs outline-none select-text [tab-size:4]",
              // The overview ruler is the vertical scrollbar; long lines keep a slim horizontal one.
              "[&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar-corner]:bg-transparent",
              "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/15",
            )}
          >
            <div className="relative" style={{ height: virtualizer.getTotalSize(), minWidth: `max(100%, ${width})` }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]!
                return (
                  <div key={item.key} className="absolute inset-x-0" style={{ top: item.start, height: item.size }}>
                    {row.type === "hunk" ? (
                      <HunkHeader hunk={row.hunk} />
                    ) : row.type === "line" ? (
                      <Line
                        line={row.line}
                        gutter={gutter}
                        tokens={sides?.[row.side]?.(row.index)}
                        changed={wordChanges(item.index)}
                      />
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
          {diff && rows.length > 0 && (
            <OverviewRuler
              blocks={blocks}
              rows={rows.length}
              viewTop={(virtualizer.scrollOffset ?? 0) / Math.max(virtualizer.getTotalSize(), 1)}
              viewHeight={(scrollRef.current?.clientHeight ?? 0) / Math.max(virtualizer.getTotalSize(), 1)}
              onJump={reveal}
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

/**
 * Lays the diff out as rows, and rebuilds the old and new file texts from
 * it so each can be highlighted whole.
 */
const flatten = (diff: FileDiff | undefined): { rows: Array<Row>; texts: [string, string]; partners: Int32Array } => {
  if (!diff) return { rows: [], texts: ["", ""], partners: new Int32Array() }
  const rows: Array<Row> = []
  const old: Array<string> = []
  const next: Array<string> = []
  // Removed and added lines in one change are paired in order, as edits of
  // each other, so their changed words can be marked.
  const pairs: Array<[number, number]> = []
  let removedRun: Array<number> = []
  let addedRun: Array<number> = []
  const closeRun = () => {
    for (let k = 0; k < Math.min(removedRun.length, addedRun.length); k++) pairs.push([removedRun[k]!, addedRun[k]!])
    removedRun = []
    addedRun = []
  }
  // The whole file comes back as one hunk, whose header says nothing new.
  const headers = diff.hunks.length > 1
  for (const hunk of diff.hunks) {
    if (headers) rows.push({ type: "hunk", hunk })
    for (const line of hunk.lines) {
      if (line.kind === "context") closeRun()
      else if (line.kind === "removed" && addedRun.length > 0) closeRun()
      if (line.kind === "removed") removedRun.push(rows.length)
      if (line.kind === "added") addedRun.push(rows.length)
      if (line.kind === "removed") {
        rows.push({ type: "line", line, side: 0, index: old.length })
        old.push(line.text)
      } else {
        rows.push({ type: "line", line, side: 1, index: next.length })
        if (line.kind === "context") old.push(line.text)
        next.push(line.text)
      }
    }
    closeRun()
  }
  if (diff.truncated) rows.push({ type: "truncated" })
  const partners = new Int32Array(rows.length).fill(-1)
  for (const [removed, added] of pairs) {
    partners[removed] = added
    partners[added] = removed
  }
  return { rows, texts: [old.join("\n"), next.join("\n")], partners }
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
    if (row.type !== "line" || row.line.kind === "context") {
      current = undefined
      return
    }
    if (!current) {
      current = { start: index, end: index, added: false, removed: false }
      blocks.push(current)
    }
    current.end = index
    if (row.line.kind === "added") current.added = true
    else current.removed = true
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
