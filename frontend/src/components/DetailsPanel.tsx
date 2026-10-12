import { useLiveQuery } from "@tanstack/react-db"
import { Effect } from "effect"
import { useState } from "react"
import { useForkedEffect } from "@/app/hooks"
import { fileStatusesCollection } from "@/data/collections"
import { formatDate, initials, shortOid } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CommitDetail, FileChangeStatus, FileStatus, Preferences, RepoId, StatusCode, WorktreeId } from "@/model/model.gen"
import type { LoadedRow } from "@/services/GraphData"
import { Rpc } from "@/services/Rpc"

interface DetailsPanelProps {
  readonly repo: RepoId
  readonly selected: LoadedRow | undefined
  readonly worktree: WorktreeId | undefined
  readonly preferences: Preferences
}

type Tab = "commit" | "changes"

/** The selected commit's details, or the active worktree's uncommitted changes. */
export const DetailsPanel = ({ repo, selected, worktree, preferences }: DetailsPanelProps) => {
  // Selecting another commit shows its details, whichever tab was open.
  const oid = selected?.row.oid
  const [chosen, setChosen] = useState<{ readonly tab: Tab; readonly oid: string | undefined }>({ tab: "commit", oid })
  const tab = chosen.oid === oid ? chosen.tab : "commit"
  const setTab = (next: Tab) => setChosen({ tab: next, oid })
  return (
    <aside aria-label="Details" className="flex w-[340px] min-w-[280px] flex-none flex-col border-l">
      <div role="tablist" className="flex gap-1 border-b px-3 pt-2">
        <TabButton active={tab === "commit"} onClick={() => setTab("commit")}>
          Commit
        </TabButton>
        <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
          Changes
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

const TabButton = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) => (
  <button
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={cn("-mb-px border-b-2 px-2 pb-2 text-xs font-medium", active ? "border-primary text-foreground" : "border-transparent text-subtle-foreground")}
  >
    {children}
  </button>
)

const Empty = ({ children }: { children: string }) => <p className="p-4 text-subtle-foreground">{children}</p>

const CommitTab = ({ repo, selected, preferences }: { repo: RepoId; selected: LoadedRow | undefined; preferences: Preferences }) => {
  const [detail, setDetail] = useState<CommitDetail>()
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
  const body = rest.join("\n").trim()
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2.5 border-b p-4">
        <div className="text-[15px] leading-snug font-semibold">{subject}</div>
        {body && <pre className="font-sans text-xs whitespace-pre-wrap text-secondary-foreground">{body}</pre>}
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-full bg-border text-[11px] font-semibold" style={{ color: "var(--lane-1)" }}>
            {initials(commit.authorName)}
          </span>
          <div className="flex flex-col">
            <span>{commit.authorName}</span>
            <span className="text-xs text-subtle-foreground">{formatDate(commit.authorTime, preferences.appearance.dateFormat)}</span>
          </div>
        </div>
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <dt className="text-subtle-foreground">Commit</dt>
          <dd className="truncate font-mono text-secondary-foreground">{commit.oid}</dd>
          <dt className="text-subtle-foreground">Parents</dt>
          <dd className="font-mono text-secondary-foreground">{commit.parents.map(shortOid).join(", ") || "none (root)"}</dd>
          {detail && detail.committerName !== commit.authorName && (
            <>
              <dt className="text-subtle-foreground">Committer</dt>
              <dd className="truncate text-secondary-foreground">{detail.committerName}</dd>
            </>
          )}
        </dl>
      </div>
      <div className="flex justify-between px-4 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle-foreground uppercase">
        <span>Changed files</span>
        <span>{detail?.files.length ?? ""}</span>
      </div>
      <ul className="flex flex-col px-2 pb-2">
        {detail?.files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <StatusBadge letter={changeLetters[file.status]} tone={changeTones[file.status]} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
              {file.path}
            </span>
            {file.binary ? (
              <span className="font-mono text-[11px] text-subtle-foreground">binary</span>
            ) : (
              <>
                <span className="font-mono text-[11px] text-success">+{file.additions}</span>
                <span className="font-mono text-[11px] text-destructive">-{file.deletions}</span>
              </>
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
            <h3 className="flex justify-between px-4 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle-foreground uppercase">
              <span>{title}</span>
              <span>{entries.length}</span>
            </h3>
            <ul className="flex flex-col px-2">
              {entries
                .sort((a, b) => a.file.path.localeCompare(b.file.path))
                .map(({ file, status }) => (
                  <li key={file.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                    <StatusBadge letter={statusLetters[status]} tone={statusTones[status]} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                  </li>
                ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

type Tone = "added" | "modified" | "deleted" | "conflict"

const toneColors: Record<Tone, string> = {
  added: "var(--success)",
  modified: "var(--warning)",
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
