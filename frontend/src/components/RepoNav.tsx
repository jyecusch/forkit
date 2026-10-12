import { useVirtualizer } from "@tanstack/react-virtual"
import { Archive, Check, ChevronRight, Folder, GitBranch, Plus, Search, Tag, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { buildNavRows, type NavRow } from "@/lib/navTree"
import { cn } from "@/lib/utils"
import { changeCount, headLabel } from "@/lib/worktree"
import type { Ref, RefId, Remote, Worktree, WorktreeId } from "@/model/model.gen"

/** Rows are 28 px; section headers add 8 px of space above. */
const rowHeight = 28
const sectionHeight = 36
/** Each nesting level moves the icon slot right by one slot. */
const levelIndent = 16
/** How long a click waits to see whether it becomes a double-click. */
const doubleClickWindow = 220

interface RepoNavProps {
  readonly refs: ReadonlyArray<Ref>
  readonly remotes: ReadonlyArray<Remote>
  readonly worktrees: ReadonlyArray<Worktree>
  readonly activeWorktree: WorktreeId | undefined
  readonly emphasized: RefId | undefined
  /** Refs whose folders stay open, such as the checked-out branch. */
  readonly reveal: ReadonlyArray<RefId>
  readonly onEmphasize: (ref: Ref) => void
  readonly onCheckout: (ref: Ref) => void
  readonly onNewWorktree: (base: Ref | undefined) => void
  readonly onSelectWorktree: (worktree: Worktree) => void
  readonly onRemoveWorktree: (worktree: Worktree) => void
}

/**
 * Everything in a repository: its worktrees, branches, remotes, tags and
 * stashes. Virtualized for repositories with thousands of refs.
 *
 * Every row has a 16 px icon slot starting on the sidebar's 16 px guide,
 * which lines up with the window controls, and labels start on a second
 * guide 8 px after it. Selection backgrounds reach 8 px past both edges.
 */
export const RepoNav = (props: RepoNavProps) => {
  const { refs, remotes, worktrees, activeWorktree, emphasized, reveal } = props
  const [filter, setFilter] = useState("")
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const filterRef = useRef<HTMLInputElement>(null)
  const rows = useMemo(
    () => buildNavRows({ refs, remotes, worktrees, reveal, toggled, filter }),
    [refs, remotes, worktrees, reveal, toggled, filter],
  )
  const worktreeNames = useMemo(() => new Map(worktrees.map((wt) => [wt.id, wt.path.split(/[\\/]/).pop() ?? wt.path])), [worktrees])

  // "/" jumps to the filter from anywhere outside a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(target.tagName)) {
        event.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "section" ? sectionHeight : rowHeight),
    overscan: 20,
  })
  useEffect(() => virtualizer.measure(), [rows, virtualizer])

  const toggle = (id: string) =>
    setToggled((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  // A single click emphasizes, but only once it is clear it was not the
  // first half of a double-click, which checks out instead.
  const pendingClick = useRef<ReturnType<typeof setTimeout>>(undefined)
  const clickRef = (ref: Ref) => {
    clearTimeout(pendingClick.current)
    pendingClick.current = setTimeout(() => props.onEmphasize(ref), doubleClickWindow)
  }
  const doubleClickRef = (ref: Ref) => {
    clearTimeout(pendingClick.current)
    props.onCheckout(ref)
  }

  // Arrow keys move between rows; left and right close and open folders.
  const onRowsKeyDown = (event: ReactKeyboardEvent) => {
    const buttons = [...(scrollRef.current?.querySelectorAll("button") ?? [])]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const expanded = (document.activeElement as HTMLElement | null)?.getAttribute("aria-expanded")
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next = buttons[current + (event.key === "ArrowDown" ? 1 : -1)]
      if (next) next.focus()
      else if (event.key === "ArrowUp") filterRef.current?.focus()
    } else if ((event.key === "ArrowRight" && expanded === "false") || (event.key === "ArrowLeft" && expanded === "true")) {
      event.preventDefault()
      buttons[current]?.click()
    }
  }

  const renderRow = (row: NavRow) => {
    switch (row.type) {
      case "section":
        return (
          <div className="group flex h-full items-end pb-1">
            <button
              onClick={() => toggle(row.id)}
              aria-expanded={!row.collapsed}
              className="flex h-6 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium text-subtle-foreground hover:text-secondary-foreground"
            >
              {row.title}
              <ChevronRight
                aria-hidden
                className={cn("size-3 opacity-0 transition group-hover:opacity-100", !row.collapsed && "rotate-90")}
              />
              {row.collapsed && <span className="ml-auto text-[11px] tabular-nums">{row.count}</span>}
            </button>
            {row.id === "worktrees" && (
              <button
                aria-label="New worktree"
                title="New worktree"
                onClick={() => props.onNewWorktree(undefined)}
                className="flex size-6 flex-none items-center justify-center rounded-md text-subtle-foreground hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            )}
          </div>
        )
      case "worktree":
        return <WorktreeRow {...props} row={row} active={row.worktree.id === activeWorktree} />
      case "remote":
        return (
          <NavButton depth={0} onClick={() => toggle(row.id)} aria-expanded={!row.collapsed} icon={<Chevron open={!row.collapsed} />}>
            <span className="truncate">{row.remote.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{hostOf(row.remote.fetchUrl)}</span>
            <Meta>{row.count}</Meta>
          </NavButton>
        )
      case "folder":
        return (
          <NavButton depth={row.depth} onClick={() => toggle(row.id)} aria-expanded={!row.collapsed} icon={<Chevron open={!row.collapsed} />}>
            <span className="truncate">{row.name}</span>
          </NavButton>
        )
      case "ref": {
        const current = row.ref.checkedOutInWorktreeId === activeWorktree && activeWorktree !== undefined
        const elsewhere = row.ref.checkedOutInWorktreeId && !current ? worktreeNames.get(row.ref.checkedOutInWorktreeId) : undefined
        const item = (
          <NavButton
            depth={row.depth}
            selected={row.ref.id === emphasized}
            title={row.ref.shortName}
            onClick={() => clickRef(row.ref)}
            onDoubleClick={() => doubleClickRef(row.ref)}
            icon={<RefIcon kind={row.ref.kind} />}
          >
            <span className="min-w-0 flex-1 truncate">
              <Highlight text={row.name} query={filter} />
            </span>
            {current && <Check aria-label="Checked out here" className="size-3.5 flex-none text-primary" />}
            {elsewhere && <Meta title={`Checked out in ${elsewhere}`}>{elsewhere}</Meta>}
            <AheadBehind ahead={row.ref.ahead} behind={row.ref.behind} />
          </NavButton>
        )
        return (
          <ContextMenu>
            <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              <ContextMenuItem disabled={current} onSelect={() => props.onCheckout(row.ref)}>
                Check out
              </ContextMenuItem>
              {row.ref.kind !== "stash" && (
                <ContextMenuItem onSelect={() => props.onNewWorktree(row.ref)}>New worktree from here…</ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => props.onEmphasize(row.ref)}>Emphasize history</ContextMenuItem>
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(row.ref.shortName)}>Copy name</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      }
    }
  }

  return (
    <nav aria-label="Repository" className="flex min-h-0 flex-1 flex-col">
      <div className="relative mx-2 mt-1 flex-none">
        <Search aria-hidden className="pointer-events-none absolute top-2 left-2 size-4 text-subtle-foreground" />
        <input
          ref={filterRef}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFilter("")
            if (event.key === "ArrowDown") {
              event.preventDefault()
              scrollRef.current?.querySelector("button")?.focus()
            }
          }}
          placeholder="Filter"
          aria-label="Filter worktrees and refs"
          className="h-8 w-full rounded-md bg-foreground/[0.05] pr-8 pl-8 outline-none placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        {filter ? (
          <button
            aria-label="Clear filter"
            onClick={() => setFilter("")}
            className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded text-subtle-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-2 right-2 font-sans text-[11px] text-subtle-foreground">/</kbd>
        )}
      </div>
      <div ref={scrollRef} onKeyDown={onRowsKeyDown} className="mt-1 flex-1 overflow-y-auto pb-2">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div key={rows[item.index]!.id} className="absolute inset-x-2" style={{ top: item.start, height: item.size }}>
              {renderRow(rows[item.index]!)}
            </div>
          ))}
        </div>
      </div>
    </nav>
  )
}

interface NavButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly depth: number
  readonly icon: ReactNode
  readonly selected?: boolean
}

/** A navigator row: icon slot on the guide for its depth, then content. */
const NavButton = ({ depth, icon, selected = false, children, className, ...rest }: NavButtonProps) => (
  <button
    {...rest}
    className={cn(
      "flex h-full w-full items-center gap-2 rounded-md pr-2 text-left",
      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      selected ? "bg-foreground/[0.08] text-foreground" : "text-secondary-foreground hover:bg-foreground/[0.04] hover:text-foreground",
      className,
    )}
    style={{ paddingLeft: 8 + depth * levelIndent }}
  >
    <span className="flex size-4 flex-none items-center justify-center text-subtle-foreground">{icon}</span>
    {children}
  </button>
)

const WorktreeRow = ({
  row,
  active,
  refs,
  onSelectWorktree,
  onRemoveWorktree,
}: { row: Extract<NavRow, { type: "worktree" }>; active: boolean } & RepoNavProps) => {
  const { worktree } = row
  const changes = changeCount(worktree)
  const refsById = useMemo(() => new Map<string, Ref>(refs.map((ref) => [ref.id, ref])), [refs])
  const item = (
    <NavButton depth={0} selected={active} title={worktree.path} onClick={() => onSelectWorktree(worktree)} icon={<Folder className="size-3.5" />}>
      <span className="truncate">{row.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{headLabel(worktree, refsById)}</span>
      {worktree.operation !== "none" && <span aria-label="Operation in progress" className="size-1.5 flex-none rounded-full bg-warning" />}
      {changes > 0 && <Meta title={`${changes} uncommitted ${changes === 1 ? "change" : "changes"}`}>{changes}</Meta>}
    </NavButton>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(worktree.path)}>Copy path</ContextMenuItem>
        {!worktree.isMain && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onRemoveWorktree(worktree)}>
              Remove worktree…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

const Meta = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span title={title} className="flex-none text-[11px] text-subtle-foreground tabular-nums">
    {children}
  </span>
)

const AheadBehind = ({ ahead, behind }: { ahead: number | undefined; behind: number | undefined }) => {
  if (!ahead && !behind) return null
  return (
    <Meta title={[ahead && `${ahead} ahead of upstream`, behind && `${behind} behind upstream`].filter(Boolean).join(", ")}>
      {ahead ? `↑${ahead}` : ""}
      {ahead && behind ? " " : ""}
      {behind ? `↓${behind}` : ""}
    </Meta>
  )
}

const Chevron = ({ open }: { open: boolean }) => (
  <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
)

const RefIcon = ({ kind }: { kind: Ref["kind"] }) => {
  switch (kind) {
    case "tag":
      return <Tag aria-hidden className="size-3.5" />
    case "stash":
      return <Archive aria-hidden className="size-3.5" />
    default:
      return <GitBranch aria-hidden className="size-3.5" />
  }
}

/** Shows text with the part that matches the filter emphasized. */
const Highlight = ({ text, query }: { text: string; query: string }) => {
  const at = query ? text.toLowerCase().indexOf(query.trim().toLowerCase()) : -1
  if (at < 0) return <>{text}</>
  const end = at + query.trim().length
  return (
    <>
      {text.slice(0, at)}
      <span className="font-semibold text-foreground">{text.slice(at, end)}</span>
      {text.slice(end)}
    </>
  )
}

/** The host of a remote URL, such as github.com, or "local" for a path. */
const hostOf = (url: string) => {
  if (url.startsWith("/") || /^[a-z]:[\\/]/i.test(url) || url.startsWith("file:")) return "local"
  return url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i)?.[1] ?? url
}
