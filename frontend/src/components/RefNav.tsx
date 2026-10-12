import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRight } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { baseName } from "@/lib/format"
import { buildNavRows, type NavRow } from "@/lib/navTree"
import { cn } from "@/lib/utils"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import type { Ref, RefId, Remote, Worktree, WorktreeId } from "@/model/model.gen"

const navRowHeight = 26

interface RefNavProps {
  readonly refs: ReadonlyArray<Ref>
  readonly remotes: ReadonlyArray<Remote>
  readonly worktrees: ReadonlyArray<Worktree>
  readonly activeWorktree: WorktreeId | undefined
  readonly emphasized: RefId | undefined
  readonly onEmphasize: (ref: Ref) => void
  readonly onCheckout: (ref: Ref) => void
  readonly onNewWorktree: (ref: Ref) => void
}

/** Branches, remotes, tags and stashes, virtualized for repositories with thousands of refs. */
export const RefNav = ({ refs, remotes, worktrees, activeWorktree, emphasized, onEmphasize, onCheckout, onNewWorktree }: RefNavProps) => {
  const [filter, setFilter] = useState("")
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo(() => buildNavRows(refs, remotes, toggled, filter), [refs, remotes, toggled, filter])
  const worktreeDirs = useMemo(() => new Map(worktrees.map((wt) => [wt.id, baseName(wt.path)])), [worktrees])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => navRowHeight,
    overscan: 20,
  })

  const toggle = (id: string) =>
    setToggled((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const meta = (ref: Ref) => {
    const parts: Array<string> = []
    if (ref.checkedOutInWorktreeId) {
      parts.push(ref.checkedOutInWorktreeId === activeWorktree ? "here" : (worktreeDirs.get(ref.checkedOutInWorktreeId) ?? ""))
    }
    if (ref.ahead) parts.push(`↑${ref.ahead}`)
    if (ref.behind) parts.push(`↓${ref.behind}`)
    return parts.join(" · ")
  }

  const renderRow = (row: NavRow) => {
    switch (row.type) {
      case "section":
        return (
          <button
            onClick={() => toggle(row.id)}
            className="flex h-full w-full items-center justify-between px-2 pt-2 text-[11px] font-semibold tracking-wider text-subtle-foreground uppercase"
          >
            <span className="flex items-center gap-1">
              <Chevron open={!row.collapsed} />
              {row.title}
            </span>
            <span>{row.count}</span>
          </button>
        )
      case "folder":
        return (
          <button
            onClick={() => toggle(row.id)}
            className="flex h-full w-full items-center gap-1.5 rounded-md pr-2 text-secondary-foreground hover:bg-accent/50"
            style={{ paddingLeft: 8 + row.depth * 14 }}
          >
            <Chevron open={!row.collapsed} />
            <span className="truncate">{row.name}</span>
          </button>
        )
      case "ref": {
        const on = row.ref.id === emphasized
        const item = (
          <button
            title="Click to emphasize, double-click to check out"
            onClick={() => onEmphasize(row.ref)}
            onDoubleClick={() => onCheckout(row.ref)}
            className={cn(
              "flex h-full w-full items-center gap-2 rounded-md pr-2 text-left",
              on ? "bg-selection text-foreground ring-1 ring-primary/50 ring-inset" : "text-secondary-foreground hover:bg-accent/50",
            )}
            style={{ paddingLeft: 22 + row.depth * 14 }}
          >
            <RefMarker kind={row.ref.kind} />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="text-[11px] whitespace-nowrap text-subtle-foreground">{meta(row.ref)}</span>
          </button>
        )
        return (
          <ContextMenu>
            <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onCheckout(row.ref)}>Check out</ContextMenuItem>
              {row.ref.kind !== "stash" && (
                <ContextMenuItem onSelect={() => onNewWorktree(row.ref)}>New worktree from here…</ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => onEmphasize(row.ref)}>Emphasize history</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      }
    }
  }

  return (
    <nav aria-label="References" className="flex w-[clamp(200px,20vw,260px)] flex-none flex-col border-r bg-sidebar">
      <label className="block px-3.5 pt-2.5 pb-1">
        <span className="sr-only">Filter references</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter"
          className="w-full rounded-md border bg-background px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 pb-2">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div key={rows[item.index]!.id} className="absolute inset-x-0" style={{ top: item.start, height: navRowHeight }}>
              {renderRow(rows[item.index]!)}
            </div>
          ))}
        </div>
      </div>
    </nav>
  )
}

const Chevron = ({ open }: { open: boolean }) => (
  <ChevronRight aria-hidden className={cn("size-3 flex-none transition-transform", open && "rotate-90")} />
)

const RefMarker = ({ kind }: { kind: Ref["kind"] }) => {
  const base = "flex-none size-2 border-[1.5px] border-current text-subtle-foreground"
  switch (kind) {
    case "localBranch":
      return <span className={cn(base, "rounded-full bg-current")} />
    case "remoteBranch":
      return <span className={cn(base, "rounded-full")} />
    case "tag":
      return <span className={cn(base, "rotate-45")} />
    case "stash":
      return <span className={cn(base, "rounded-[2px]")} />
  }
}
