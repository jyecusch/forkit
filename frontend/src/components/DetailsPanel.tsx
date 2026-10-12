import { useLiveQuery } from "@tanstack/react-db"
import { Effect } from "effect"
import { Check, Copy } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { useForkedEffect } from "@/app/hooks"
import { useNow } from "@/app/useNow"
import { fileStatusesCollection } from "@/data/collections"
import { formatDate, formatFullDate, initials, reflow, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CommitDetail, FileChangeStatus, FileStatus, Preferences, RepoId, StatusCode, WorktreeId } from "@/model/model.gen"
import type { LoadedRow } from "@/services/GraphData"
import { Rpc } from "@/services/Rpc"

interface DetailsPanelProps {
  readonly repo: RepoId
  readonly selected: LoadedRow | undefined
  readonly worktree: WorktreeId | undefined
  /** Uncommitted changes in the worktree, shown on the Changes tab. */
  readonly changes: number
  readonly preferences: Preferences
}

type Tab = "commit" | "changes"

/** The selected commit's details, or the active worktree's uncommitted changes. */
export const DetailsPanel = ({ repo, selected, worktree, changes, preferences }: DetailsPanelProps) => {
  // Selecting another commit shows its details, whichever tab was open.
  const oid = selected?.row.oid
  const [chosen, setChosen] = useState<{ readonly tab: Tab; readonly oid: string | undefined }>({ tab: "commit", oid })
  const tab = chosen.oid === oid ? chosen.tab : "commit"
  const setTab = (next: Tab) => setChosen({ tab: next, oid })
  return (
    <aside aria-label="Details" className="flex w-[clamp(260px,26vw,340px)] flex-none flex-col border-l">
      <div
        role="tablist"
        aria-label="Details"
        className="flex h-8 flex-none items-center gap-0.5 border-b px-2"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          setTab(tab === "commit" ? "changes" : "commit")
          const list = event.currentTarget
          requestAnimationFrame(() => list.querySelector<HTMLElement>("[aria-selected=true]")?.focus())
        }}
      >
        <TabButton active={tab === "commit"} onClick={() => setTab("commit")}>
          Commit
        </TabButton>
        <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
          Changes
          {changes > 0 && <span className="ml-1.5 text-subtle-foreground tabular-nums">{changes}</span>}
        </TabButton>
      </div>
      <div className="flex-1 overflow-y-auto select-text">
        {tab === "commit" ? (
          <CommitTab repo={repo} selected={selected} preferences={preferences} />
        ) : worktree ? (
          <ChangesTab worktree={worktree} />
        ) : (
          <Empty>No worktree selected</Empty>
        )}
      </div>
    </aside>
  )
}

const TabButton = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <button
    role="tab"
    aria-selected={active}
    tabIndex={active ? 0 : -1}
    onClick={onClick}
    className={cn(
      "flex h-6 items-center rounded-md px-2 text-xs font-medium",
      active ? "bg-foreground/[0.08] text-foreground" : "text-subtle-foreground hover:bg-foreground/[0.05] hover:text-foreground",
    )}
  >
    {children}
  </button>
)

const Empty = ({ children }: { children: string }) => (
  <p className="flex h-full items-center justify-center p-6 text-center text-subtle-foreground">{children}</p>
)

const CommitTab = ({ repo, selected, preferences }: { repo: RepoId; selected: LoadedRow | undefined; preferences: Preferences }) => {
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
          <span
            aria-hidden
            className="flex size-7 flex-none items-center justify-center rounded-full bg-foreground/[0.08] text-[11px] font-semibold text-secondary-foreground"
          >
            {initials(commit.authorName)}
          </span>
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
        {detail?.files.map((file) => (
          <li key={file.path} className={fileRow}>
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
          </li>
        ))}
      </ul>
    </div>
  )
}

const ChangesTab = ({ worktree }: { worktree: WorktreeId }) => {
  const { data: files } = useLiveQuery({ query: (q) => q.from({ file: fileStatusesCollection(worktree) }) })
  if (files.length === 0) {
    return <Empty>No uncommitted changes</Empty>
  }
  const groups: Array<[string, (file: FileStatus) => StatusCode | undefined]> = [
    ["Conflicted", (f) => (f.index === "unmerged" ? f.index : undefined)],
    ["Staged", (f) => (f.index !== "unmodified" && f.index !== "untracked" && f.index !== "unmerged" ? f.index : undefined)],
    ["Unstaged", (f) => (f.workTree !== "unmodified" && f.workTree !== "untracked" && f.workTree !== "unmerged" ? f.workTree : undefined)],
    ["Untracked", (f) => (f.index === "untracked" ? f.index : undefined)],
  ]
  return (
    <div className="flex flex-col pb-2">
      {groups.map(([title, statusOf]) => {
        const entries = files.flatMap((file) => {
          const status = statusOf(file)
          return status ? [{ file, status }] : []
        })
        if (entries.length === 0) return null
        return (
          <section key={title}>
            <h3 className="flex justify-between px-4 pt-3 pb-1.5 text-xs font-medium text-subtle-foreground">
              <span>{title}</span>
              <span>{entries.length}</span>
            </h3>
            <ul className="flex flex-col px-2">
              {entries
                .sort((a, b) => a.file.path.localeCompare(b.file.path))
                .map(({ file, status }) => (
                  <li key={file.id} className={fileRow}>
                    <StatusBadge letter={statusLetters[status]} tone={statusTones[status]} />
                    <FilePath path={file.path} title={file.path} />
                  </li>
                ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

const fileRow = "flex h-7 items-center gap-2 px-2"

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
