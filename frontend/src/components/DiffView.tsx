import { useVirtualizer } from "@tanstack/react-virtual"
import { Effect } from "effect"
import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useForkedEffect } from "@/app/hooks"
import { highlight } from "@/highlight/client"
import { syntaxStyles, tokenStride } from "@/highlight/styles"
import { shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
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

  const { rows, texts } = useMemo(() => flatten(diff), [diff])

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
  const changes = useMemo(() => changeStarts(rows), [rows])

  // Scrolls a change to a third of the way down, with context above it.
  const third = () => (scrollRef.current?.clientHeight ?? 0) / 3
  const reveal = (row: number) => {
    const start = virtualizer.measurementsCache[row]?.start ?? row * lineHeight
    virtualizer.scrollToOffset(Math.max(start - third(), 0))
  }
  // Changes are counted from the row a third of the way down.
  const anchorRow = () => virtualizer.getVirtualItemForOffset((virtualizer.scrollOffset ?? 0) + third())?.index ?? 0
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
                  {changes.length} {changes.length === 1 ? "change" : "changes"}
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
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-busy={!diff}
          className="relative flex-1 overflow-auto font-mono text-xs outline-none select-text [tab-size:4]"
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize(), minWidth: `max(100%, ${width})` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!
              return (
                <div key={item.key} className="absolute inset-x-0" style={{ top: item.start, height: item.size }}>
                  {row.type === "hunk" ? (
                    <HunkHeader hunk={row.hunk} />
                  ) : row.type === "line" ? (
                    <Line line={row.line} gutter={gutter} tokens={sides?.[row.side]?.(row.index)} />
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

const Line = ({ line, gutter, tokens }: { line: DiffLine; gutter: string; tokens: Int32Array | undefined }) => {
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
      <span className="pr-4 text-foreground">{tokens && tokens.length > 0 ? colour(line.text, tokens) : line.text}</span>
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
const flatten = (diff: FileDiff | undefined): { rows: Array<Row>; texts: [string, string] } => {
  if (!diff) return { rows: [], texts: ["", ""] }
  const rows: Array<Row> = []
  const old: Array<string> = []
  const next: Array<string> = []
  // The whole file comes back as one hunk, whose header says nothing new.
  const headers = diff.hunks.length > 1
  for (const hunk of diff.hunks) {
    if (headers) rows.push({ type: "hunk", hunk })
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        rows.push({ type: "line", line, side: 0, index: old.length })
        old.push(line.text)
      } else {
        rows.push({ type: "line", line, side: 1, index: next.length })
        if (line.kind === "context") old.push(line.text)
        next.push(line.text)
      }
    }
  }
  if (diff.truncated) rows.push({ type: "truncated" })
  return { rows, texts: [old.join("\n"), next.join("\n")] }
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

/** Splits a line into its highlighted tokens and the plain text between them. */
const colour = (text: string, tokens: Int32Array) => {
  const parts: Array<React.ReactNode> = []
  let at = 0
  for (let i = 0; i < tokens.length; i += tokenStride) {
    const from = tokens[i + 1]!
    const to = tokens[i + 2]!
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <span key={from} className={`syn-${syntaxStyles[tokens[i + 3]!]}`}>
        {text.slice(from, to)}
      </span>,
    )
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/** The rows where each run of changed lines begins. */
const changeStarts = (rows: ReadonlyArray<Row>) => {
  const starts: Array<number> = []
  rows.forEach((row, index) => {
    const changed = row.type === "line" && row.line.kind !== "context"
    const previous = rows[index - 1]
    const previousChanged = previous?.type === "line" && previous.line.kind !== "context"
    if (changed && !previousChanged) starts.push(index)
  })
  return starts
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
