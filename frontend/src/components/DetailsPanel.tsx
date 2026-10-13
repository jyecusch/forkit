import { useLiveQuery } from "@tanstack/react-db"
import { Effect } from "effect"
import { Check, Copy, Minus, Plus } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useForkedEffect, useRun } from "@/app/hooks"
import { useLayoutSize } from "@/app/layoutSizes"
import { useNow } from "@/app/useNow"
import { fileStatusesCollection } from "@/data/collections"
import { formatDate, formatFullDate, reflow, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CommitDetail, DiffKind, FileChangeStatus, FileStatus, Preferences, RepoId, StatusCode, WorktreeId } from "@/model/model.gen"
import type { LoadedRow } from "@/services/GraphData"
import { Rpc } from "@/services/Rpc"
import { Avatar } from "./Avatar"
import { CommitComposer } from "./CommitComposer"
import { sameDiff, type DiffTarget } from "./DiffView"
import { ResizeHandle } from "./ResizeHandle"

interface DetailsPanelProps {
  readonly repo: RepoId
  readonly selected: LoadedRow | undefined
  readonly worktree: WorktreeId | undefined
  /** The uncommitted changes row is selected, rather than a commit. */
  readonly showChanges: boolean
  readonly preferences: Preferences
  /** The file whose diff is open, highlighted in the lists. */
  readonly openDiff: DiffTarget | undefined
  readonly onOpenDiff: (target: DiffTarget) => void
}

/** Whatever is selected in the graph: a commit's details, or the active worktree's uncommitted changes. */
export const DetailsPanel = ({ repo, selected, worktree, showChanges, preferences, openDiff, onOpenDiff }: DetailsPanelProps) => {
  const ref = useRef<HTMLElement>(null)
  const width = useLayoutSize("details")
  return (
    <aside
      ref={ref}
      aria-label="Details"
      className="relative flex w-[clamp(260px,26vw,340px)] flex-none flex-col border-l"
      style={width.size === undefined ? undefined : { width: width.size }}
    >
      <ResizeHandle
        label="Resize details"
        orientation="vertical"
        grows={-1}
        measure={() => ref.current?.offsetWidth ?? 0}
        limits={() => [240, 720]}
        control={width}
        className="absolute inset-y-0 -left-1"
      />
      <div className="min-h-0 flex-1 overflow-y-auto select-text" onKeyDown={moveBetweenFiles}>
        {showChanges && worktree ? (
          <ChangesTab worktree={worktree} openDiff={openDiff} onOpenDiff={onOpenDiff} />
        ) : (
          <CommitTab repo={repo} selected={selected} preferences={preferences} openDiff={openDiff} onOpenDiff={onOpenDiff} />
        )}
      </div>
    </aside>
  )
}

const Empty = ({ children }: { children: string }) => (
  <p className="flex h-full items-center justify-center p-6 text-center text-subtle-foreground">{children}</p>
)

interface FileListProps {
  readonly openDiff: DiffTarget | undefined
  readonly onOpenDiff: (target: DiffTarget) => void
}

const CommitTab = ({
  repo,
  selected,
  preferences,
  openDiff,
  onOpenDiff,
}: { repo: RepoId; selected: LoadedRow | undefined; preferences: Preferences } & FileListProps) => {
  const [detail, setDetail] = useState<CommitDetail>()
  const now = useNow()
  const oid = selected?.row.oid
  useForkedEffect(
    () =>
      Effect.gen(function* () {
        setDetail(undefined)
        if (!oid) return
        const loaded = yield* Rpc.use((rpc) => rpc.commitDetail(repo, oid))
        setDetail(loaded)
      }),
    [repo, oid],
  )

  if (!selected) {
    return <Empty>Select a commit to see its details</Empty>
  }
  const { commit } = selected
  const [subject, ...rest] = (detail?.body ?? commit.subject).split("\n")
  const body = reflow(rest.join("\n").trim())
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2.5 border-b p-4">
        <div className="text-[15px] leading-snug font-semibold">{subject}</div>
        {body && <pre className="font-sans text-xs whitespace-pre-wrap text-secondary-foreground">{body}</pre>}
        <div className="flex items-center gap-2.5">
          <Avatar name={commit.authorName} email={commit.authorEmail} size={28} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{commit.authorName}</span>
            <span className="text-xs text-subtle-foreground" title={formatFullDate(commit.authorTime)}>
              {formatDate(commit.authorTime, preferences.appearance.dateFormat, now)}
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs [&>dd]:flex [&>dd]:h-5 [&>dd]:items-center">
          <dt className="text-subtle-foreground">Commit</dt>
          <dd className="min-w-0 gap-1 font-mono text-secondary-foreground">
            <span title={commit.oid}>{commit.oid.slice(0, 12)}</span>
            <CopyButton text={commit.oid} label="Copy full SHA" />
          </dd>
          <dt className="text-subtle-foreground">Parents</dt>
          <dd className="font-mono text-secondary-foreground">{commit.parents.map(shortOid).join(", ") || "none (root)"}</dd>
          {detail && detail.committerName !== commit.authorName && (
            <>
              <dt className="text-subtle-foreground">Committer</dt>
              <dd className="text-secondary-foreground">
                <span className="truncate">{detail.committerName}</span>
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="flex justify-between px-4 pt-3 pb-1.5 text-xs font-medium text-subtle-foreground">
        <span>Changed files</span>
        <span>{detail?.files.length ?? ""}</span>
      </div>
      {detail && detail.files.length === 0 && <p className="px-4 text-xs text-subtle-foreground">No files changed</p>}
      <ul className="flex flex-col px-2 pb-2">
        {detail?.files.map((file) => {
          const target: DiffTarget = {
            request: { kind: "commit", oid: detail.oid, path: file.path, ...(file.oldPath && { oldPath: file.oldPath }) },
            conflicted: false,
          }
          return (
            <li key={file.path}>
              <FileButton target={target} openDiff={openDiff} onOpenDiff={onOpenDiff}>
                <StatusBadge letter={changeLetters[file.status]} tone={changeTones[file.status]} />
                <FilePath path={file.path} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} />
                {file.binary ? (
                  <span className="text-[11px] text-subtle-foreground">binary</span>
                ) : (
                  <span className="grid grid-cols-[4ch_4ch] gap-1 text-right font-mono text-[11px] tabular-nums">
                    <span className="text-success">+{file.additions}</span>
                    <span className="text-destructive">−{file.deletions}</span>
                  </span>
                )}
              </FileButton>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** A group of changed files, and how a file moves out of it. */
interface Group {
  readonly title: string
  readonly kind: DiffKind
  readonly statusOf: (file: FileStatus) => StatusCode | undefined
  /** Staging moves a file into the index; unstaging moves it back out. */
  readonly action: "stage" | "unstage"
  /** A colour for the title of a group that needs attention. */
  readonly titleClass?: string
}

const groups: ReadonlyArray<Group> = [
  { title: "Conflicted", kind: "unstaged", action: "stage", titleClass: "text-destructive", statusOf: (f) => (f.index === "unmerged" ? f.index : undefined) },
  {
    title: "Staged",
    kind: "staged",
    action: "unstage",
    titleClass: "text-success",
    statusOf: (f) => (f.index !== "unmodified" && f.index !== "untracked" && f.index !== "unmerged" ? f.index : undefined),
  },
  {
    title: "Unstaged",
    kind: "unstaged",
    action: "stage",
    statusOf: (f) => (f.workTree !== "unmodified" && f.workTree !== "untracked" && f.workTree !== "unmerged" ? f.workTree : undefined),
  },
  { title: "Untracked", kind: "untracked", action: "stage", statusOf: (f) => (f.index === "untracked" ? f.index : undefined) },
]

const ChangesTab = ({ worktree, openDiff, onOpenDiff }: { worktree: WorktreeId } & FileListProps) => {
  const run = useRun()
  const filesRef = useRef<HTMLDivElement>(null)
  const stagedRef = useRef<HTMLDivElement>(null)
  // The staged section's share of the file lists' height.
  const stagedShare = useLayoutSize("staged")
  const { data: files } = useLiveQuery({ query: (q) => q.from({ file: fileStatusesCollection(worktree) }) })
  const sections = groups.flatMap((group) => {
    const entries = files
      .flatMap((file) => {
        const status = group.statusOf(file)
        return status ? [{ file, status }] : []
      })
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
    return entries.length > 0 ? [{ group, entries }] : []
  })
  const staged = sections.find((section) => section.group.kind === "staged")?.entries.length ?? 0

  // Moves files in or out of the index. An open diff of one of them follows
  // it to its new group.
  const apply = (action: Group["action"], paths: ReadonlyArray<string>) => {
    const open = openDiff?.request
    if (open?.worktreeId === worktree && paths.includes(open.path)) {
      onOpenDiff({ ...openDiff!, request: { ...open, kind: action === "stage" ? "staged" : "unstaged" } })
    }
    void run(Rpc.use((rpc) => (action === "stage" ? rpc.stage(worktree, paths) : rpc.unstage(worktree, paths))))
  }

  const renderSection = (group: Group, entries: ReadonlyArray<{ file: FileStatus; status: StatusCode }>) => (
    <section key={group.title}>
      <h3 className="flex h-9 items-end justify-between gap-2 px-4 pb-1.5 text-xs font-medium text-subtle-foreground">
        <span className={group.titleClass}>
          {group.title} <span className="font-normal tabular-nums">{entries.length}</span>
        </span>
        {entries.length > 0 && (
          <button
            onClick={() => apply(group.action, entries.map(({ file }) => file.path))}
            className="-mr-1.5 rounded px-1.5 py-0.5 font-normal hover:bg-foreground/[0.05] hover:text-foreground"
          >
            {group.action === "stage" ? "Stage all" : "Unstage all"}
          </button>
        )}
      </h3>
      <ul className="flex flex-col px-2">
        {entries.map(({ file, status }) => {
          const target: DiffTarget = {
            request: { kind: group.kind, worktreeId: worktree, path: file.path, ...(file.oldPath && { oldPath: file.oldPath }) },
            conflicted: status === "unmerged",
          }
          return (
            <li key={file.id} className="group/file relative">
              <FileButton target={target} openDiff={openDiff} onOpenDiff={onOpenDiff}>
                <StatusBadge letter={statusLetters[status]} tone={statusTones[status]} />
                <FilePath path={file.path} title={file.path} />
              </FileButton>
              <button
                aria-label={`${group.action === "stage" ? "Stage" : "Unstage"} ${file.path}`}
                title={group.action === "stage" ? "Stage" : "Unstage"}
                onClick={() => apply(group.action, [file.path])}
                className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded bg-background text-subtle-foreground opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100 hover:text-foreground focus-visible:opacity-100"
              >
                {group.action === "stage" ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )

  // What is not yet staged comes first; what will be committed sits apart,
  // just above the commit composer.
  const unstaged = sections.filter(({ group }) => group.kind !== "staged")
  const stagedGroup = groups.find((group) => group.kind === "staged")!
  const stagedEntries = sections.find(({ group }) => group.kind === "staged")?.entries ?? []

  return (
    <div className="flex h-full flex-col">
      <h2 className="flex-none px-4 pt-4 text-[15px] leading-snug font-semibold">Uncommitted changes</h2>
      {files.length === 0 ? (
        <div className="min-h-0 flex-1">
          <Empty>No uncommitted changes</Empty>
        </div>
      ) : (
        <div ref={filesRef} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {unstaged.length > 0 ? (
              unstaged.map(({ group, entries }) => renderSection(group, entries))
            ) : (
              <p className="px-4 pt-3 text-xs text-subtle-foreground">Everything is staged.</p>
            )}
          </div>
          <ResizeHandle
            label="Resize staged files"
            orientation="horizontal"
            grows={-1}
            measure={() => stagedRef.current?.offsetHeight ?? 0}
            limits={() => [96, Math.max((filesRef.current?.offsetHeight ?? 0) - 96, 96)]}
            toSize={(px) => px / (filesRef.current?.offsetHeight || 1)}
            control={stagedShare}
            className="relative -my-1 flex-none"
          />
          <div
            ref={stagedRef}
            className={cn("flex min-h-24 flex-none flex-col overflow-y-auto border-t pb-2", stagedShare.size === undefined && "max-h-[40%]")}
            style={stagedShare.size === undefined ? undefined : { height: `${stagedShare.size * 100}%` }}
          >
            {renderSection(stagedGroup, stagedEntries)}
            {stagedEntries.length === 0 && <p className="px-4 text-xs text-subtle-foreground">Stage files to commit them.</p>}
          </div>
        </div>
      )}
      <CommitComposer worktree={worktree} staged={staged} />
    </div>
  )
}

/** A file in a list, which opens its diff. */
const FileButton = ({ target, openDiff, onOpenDiff, children }: { target: DiffTarget; children: ReactNode } & FileListProps) => {
  const open = sameDiff(target, openDiff)
  return (
    <button
      data-file
      aria-current={open}
      onClick={() => onOpenDiff(target)}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        open ? "bg-selection" : "hover:bg-foreground/[0.05]",
      )}
    >
      {children}
    </button>
  )
}

/** Up and down move between files, opening each in turn. */
const moveBetweenFiles = (event: React.KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  // Option-arrows move between changes in the open diff instead.
  if (event.altKey || event.metaKey || event.ctrlKey) return
  const files = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-file]")]
  const current = files.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) return
  event.preventDefault()
  const next = files[current + (event.key === "ArrowDown" ? 1 : -1)]
  next?.focus()
  next?.click()
}

/** A path with its file name first and its directory dimmed after it. */
const FilePath = ({ path, title }: { path: string; title: string }) => {
  const slash = path.lastIndexOf("/")
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs" title={title}>
      <span className="truncate">{path.slice(slash + 1)}</span>
      {slash >= 0 && <span className="min-w-0 flex-1 truncate text-subtle-foreground">{path.slice(0, slash)}</span>}
    </span>
  )
}

const CopyButton = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  const Icon = copied ? Check : Copy
  return (
    <button
      aria-label={label}
      title={label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      className="flex size-5 flex-none items-center justify-center rounded text-subtle-foreground hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <Icon className="size-3" />
    </button>
  )
}

type Tone = "added" | "modified" | "deleted" | "conflict"

const toneColors: Record<Tone, string> = {
  added: "var(--success)",
  modified: "var(--lane-0)",
  deleted: "var(--destructive)",
  conflict: "var(--destructive)",
}

const StatusBadge = ({ letter, tone }: { letter: string; tone: Tone }) => (
  <span
    className="flex size-[18px] flex-none items-center justify-center rounded font-mono text-[11px] font-semibold"
    style={{ color: toneColors[tone], background: `color-mix(in srgb, ${toneColors[tone]} 14%, transparent)` }}
  >
    {letter}
  </span>
)

const changeLetters: Record<FileChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
}

const changeTones: Record<FileChangeStatus, Tone> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "modified",
  copied: "added",
  typeChanged: "modified",
}

const statusLetters: Record<StatusCode, string> = {
  unmodified: " ",
  modified: "M",
  typeChanged: "T",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  ignored: "!",
  unmerged: "U",
}

const statusTones: Record<StatusCode, Tone> = {
  unmodified: "modified",
  modified: "modified",
  typeChanged: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "modified",
  copied: "added",
  untracked: "added",
  ignored: "modified",
  unmerged: "conflict",
}
