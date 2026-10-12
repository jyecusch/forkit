import { useVirtualizer } from "@tanstack/react-virtual"
import { Archive, Check, ChevronRight, GitBranch, Plus, Search, Server, Tag, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { buildNavRows, revealedNodes, type NavRow } from "@/lib/navTree"
import { cn } from "@/lib/utils"
import { changeCount, headLabel } from "@/lib/worktree"
import type { Ref, RefId, Remote, Worktree, WorktreeId } from "@/model/model.gen"
import { WorktreeIcon } from "./WorktreeIcon"

/** Rows are 28 px; section headers add 8 px of space above. */
const rowHeight = 28
const sectionHeight = 36
/** Each nesting level moves the icon slot right by one slot. */
const levelIndent = 16

interface TreeItemProps {
  readonly role: "treeitem"
  readonly "aria-level": number
  readonly tabIndex: number
  readonly onFocus: () => void
}

interface RepoNavProps {
  /** Whether this repository is on screen, so its shortcuts apply. */
  readonly active: boolean
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
  const { active, refs, remotes, worktrees, activeWorktree, emphasized, reveal } = props
  const [filter, setFilter] = useState("")
  // Open and closed choices made while filtering are forgotten with the filter.
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [filterChoices, setFilterChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const changeFilter = (value: string) => {
    setFilter(value)
    setFilterChoices(new Map())
  }
  // Folders opened to reveal a ref stay open after it moves on.
  const revealing = useMemo(() => revealedNodes(refs, remotes, reveal), [refs, remotes, reveal])
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(revealing)
  if ([...revealing].some((node) => !revealed.has(node))) {
    setRevealed(new Set([...revealed, ...revealing]))
  }

  const filterRef = useRef<HTMLInputElement>(null)
  const filtering = filter.trim() !== ""
  const rows = useMemo(
    () => buildNavRows({ refs, remotes, worktrees, revealed, choices: filtering ? filterChoices : choices, filter }),
    [refs, remotes, worktrees, revealed, filtering, filterChoices, choices, filter],
  )
  const worktreeNames = useMemo(() => new Map(worktrees.map((wt) => [wt.id, wt.path.split(/[\\/]/).pop() ?? wt.path])), [worktrees])
  const showHosts = new Set(remotes.map((remote) => hostOf(remote.fetchUrl))).size > 1

  // "/" jumps to the filter from anywhere outside a text field or dialog.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const modalOpen = document.querySelector("[role=dialog][data-state=open]") !== null
      if (event.key === "/" && !modalOpen && !["INPUT", "TEXTAREA"].includes(target.tagName)) {
        event.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "section" ? sectionHeight : rowHeight),
    overscan: 20,
  })
  useEffect(() => virtualizer.measure(), [rows, virtualizer])
  const items = virtualizer.getVirtualItems()

  // The tree is one tab stop: the row last focused, or the first on screen.
  const [focusId, setFocusId] = useState<string>()
  const tabbableId = items.some((item) => rows[item.index]?.id === focusId) ? focusId : rows[items[0]?.index ?? -1]?.id
  const treeItem = (row: NavRow, level: number): TreeItemProps => ({
    role: "treeitem",
    "aria-level": level,
    tabIndex: row.id === tabbableId ? 0 : -1,
    onFocus: () => setFocusId(row.id),
  })

  const setOpen = (id: string, open: boolean) =>
    (filtering ? setFilterChoices : setChoices)((current) => new Map(current).set(id, open))

  const onTreeKeyDown = (event: ReactKeyboardEvent) => {
    const items = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])]
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    const item = items[current]!
    const expanded = item.getAttribute("aria-expanded")
    const level = Number(item.getAttribute("aria-level"))
    const parent = () =>
      items
        .slice(0, current)
        .reverse()
        .find((other) => Number(other.getAttribute("aria-level")) < level)
    const action = {
      Home: () => items[0]?.focus(),
      End: () => items[items.length - 1]?.focus(),
      Escape: filtering
        ? () => {
            changeFilter("")
            filterRef.current?.focus()
          }
        : undefined,
      ArrowDown: () => items[current + 1]?.focus(),
      ArrowUp: () => (current === 0 ? filterRef.current : items[current - 1])?.focus(),
      ArrowRight: () => (expanded === "false" ? item.click() : expanded === "true" ? items[current + 1]?.focus() : undefined),
      ArrowLeft: () => (expanded === "true" ? item.click() : parent()?.focus()),
    }[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  const renderRow = (row: NavRow) => {
    switch (row.type) {
      case "section":
        return (
          <div className="group/row relative flex h-full items-end pb-1">
            <button
              {...treeItem(row, 1)}
              onClick={() => setOpen(row.id, row.collapsed)}
              aria-expanded={!row.collapsed}
              className="group flex h-6 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium text-subtle-foreground hover:text-secondary-foreground"
            >
              {row.title}
              <span className="ml-auto flex items-center gap-2">
                {row.collapsed && <span className="text-[11px] font-normal tabular-nums">{row.count}</span>}
                <TrailingChevron open={!row.collapsed} />
              </span>
            </button>
            {row.id === "worktrees" && (
              <button
                aria-label="New worktree"
                title="New worktree"
                tabIndex={-1}
                onClick={() => props.onNewWorktree(undefined)}
                className="absolute right-6 bottom-1 flex size-6 items-center justify-center rounded-md text-subtle-foreground opacity-0 group-hover/row:opacity-100 hover:bg-foreground/[0.05] hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            )}
          </div>
        )
      case "worktree":
        return <WorktreeRow {...props} row={row} active={row.worktree.id === activeWorktree} tree={treeItem(row, 2)} />
      case "remote": {
        const host = hostOf(row.remote.fetchUrl)
        return (
          <NavButton
            {...treeItem(row, 2)}
            depth={0}
            onClick={() => setOpen(row.id, row.collapsed)}
            aria-expanded={!row.collapsed}
            title={row.remote.fetchUrl}
            icon={<Server aria-hidden className="size-3.5" />}
          >
            <span className="truncate">{row.remote.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{showHosts && host !== "local" ? host : ""}</span>
            {row.collapsed && <Meta>{row.count}</Meta>}
            <TrailingChevron open={!row.collapsed} />
          </NavButton>
        )
      }
      case "folder":
        return (
          <NavButton
            {...treeItem(row, row.depth + 2)}
            depth={row.depth}
            onClick={() => setOpen(row.id, row.collapsed)}
            aria-expanded={!row.collapsed}
            icon={<Chevron open={!row.collapsed} />}
          >
            <span className="truncate">
              <Highlight text={row.name} query={filter} />
            </span>
          </NavButton>
        )
      case "ref": {
        const current = row.ref.checkedOutInWorktreeId === activeWorktree && activeWorktree !== undefined
        const elsewhere = current ? undefined : worktrees.find((wt) => wt.id === row.ref.checkedOutInWorktreeId)
        // A branch checked out in another worktree is opened there instead.
        const open = () => (elsewhere ? props.onSelectWorktree(elsewhere) : props.onCheckout(row.ref))
        const item = (
          <NavButton
            {...treeItem(row, row.depth + 2)}
            depth={row.depth}
            selected={row.ref.id === emphasized}
            aria-selected={row.ref.id === emphasized}
            title={row.ref.shortName}
            onClick={() => props.onEmphasize(row.ref)}
            onDoubleClick={open}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                open()
              }
            }}
            icon={<RefIcon kind={row.ref.kind} />}
          >
            <span className="min-w-0 flex-1 truncate">
              <Highlight text={row.name} query={filter} />
            </span>
            {current && <Check aria-label="Checked out here" className="size-3.5 flex-none text-secondary-foreground" />}
            {elsewhere && <Meta title={`Checked out in ${worktreeNames.get(elsewhere.id)}`}>{worktreeNames.get(elsewhere.id)}</Meta>}
            <AheadBehind ahead={row.ref.ahead} behind={row.ref.behind} />
          </NavButton>
        )
        return (
          <ContextMenu>
            <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              <ContextMenuItem disabled={current} onSelect={open}>
                {elsewhere
                  ? `Switch to ${worktreeNames.get(elsewhere.id)}`
                  : row.ref.kind === "remoteBranch"
                    ? "Check out as local branch…"
                    : "Check out"}
                <span className="ml-auto text-xs text-subtle-foreground">⌘↩</span>
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
          onChange={(event) => changeFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") changeFilter("")
            if (event.key === "ArrowDown") {
              event.preventDefault()
              scrollRef.current?.querySelector<HTMLElement>("[role=treeitem]")?.focus()
            }
          }}
          placeholder="Filter"
          aria-label="Filter worktrees and refs"
          className="h-8 w-full rounded-md bg-foreground/[0.05] pr-8 pl-8 outline-none placeholder:text-subtle-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
        />
        {filter ? (
          <button
            aria-label="Clear filter"
            onClick={() => changeFilter("")}
            className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded text-subtle-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-2 right-2 font-sans text-[11px] text-subtle-foreground">/</kbd>
        )}
      </div>
      <div
        ref={scrollRef}
        role="tree"
        aria-label="Worktrees and refs"
        onKeyDown={onTreeKeyDown}
        className="mt-1 flex-1 overflow-y-auto pb-2 [mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => (
            <div key={rows[item.index]!.id} role="none" className="absolute inset-x-2" style={{ top: item.start, height: item.size }}>
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
  /** Where the user is: the active worktree, or the emphasized ref. */
  readonly selected?: boolean
}

/**
 * A navigator row: icon slot on the guide for its depth, then content. The
 * selected rows take the theme's highlight colour.
 */
const NavButton = ({ depth, icon, selected = false, children, className, ...rest }: NavButtonProps) => (
  <button
    {...rest}
    className={cn(
      "group flex h-full w-full items-center gap-2 rounded-md pr-2 text-left",
      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      "data-[state=open]:shadow-[inset_0_0_0_1px_var(--ring)]",
      selected
        ? "bg-highlight/15 font-medium text-foreground"
        : "text-secondary-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      className,
    )}
    style={{ paddingLeft: 8 + depth * levelIndent }}
  >
    <span className={cn("flex size-4 flex-none items-center justify-center", selected ? "text-highlight" : "text-subtle-foreground")}>
      {icon}
    </span>
    {children}
  </button>
)

const WorktreeRow = ({
  row,
  active,
  refs,
  onSelectWorktree,
  onRemoveWorktree,
  tree,
}: { row: Extract<NavRow, { type: "worktree" }>; active: boolean; tree: TreeItemProps } & RepoNavProps) => {
  const { worktree } = row
  const changes = changeCount(worktree)
  const refsById = useMemo(() => new Map<string, Ref>(refs.map((ref) => [ref.id, ref])), [refs])
  const item = (
    <NavButton {...tree} depth={0} selected={active} aria-selected={active} title={worktree.path} onClick={() => onSelectWorktree(worktree)} icon={<WorktreeIcon worktree={worktree} className="size-3.5" />}>
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

/**
 * The disclosure for sections and remotes, which have their own icon: at
 * the row's end, faint while closed and shown on hover while open.
 */
const TrailingChevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    aria-hidden
    className={cn(
      "size-3 flex-none transition",
      open ? "rotate-90 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "opacity-60",
    )}
  />
)

const Chevron = ({ open }: { open: boolean }) => (
  <ChevronRight aria-hidden className={cn("size-3.5 flex-none transition-transform", open && "rotate-90")} />
)

const RefIcon = ({ kind }: { kind: Ref["kind"] }) => {
  switch (kind) {
    case "tag":
      return <Tag aria-hidden className="size-3.5" />
    case "stash":
      return <Archive aria-hidden className="size-3.5" />
    case "remoteBranch":
      return <GitBranch aria-hidden className="size-3.5 opacity-60" />
    case "localBranch":
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
      <mark className="rounded-sm bg-primary/20 text-foreground">{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  )
}

/** The host of a remote URL, such as github.com, or "local" for a path. */
const hostOf = (url: string) => {
  if (url.startsWith("/") || /^[a-z]:[\\/]/i.test(url) || url.startsWith("file:")) return "local"
  return url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i)?.[1] ?? url
}
