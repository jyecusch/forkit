import { useLiveQuery } from "@tanstack/react-db"
import { useCallback, useMemo, useState } from "react"
import { useRun } from "@/app/hooks"
import { graphViewsCollection, refsCollection, remotesCollection, worktreesCollection } from "@/data/collections"
import { baseName } from "@/lib/format"
import type { OpenRepo, Preferences, Ref, Repo, RepoId, Worktree } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import type { LoadedRow } from "@/services/GraphData"
import { DetailsPanel } from "./DetailsPanel"
import { GraphPane, type ScrollRequest } from "./GraphPane"
import { RefNav } from "./RefNav"
import { StatusBar } from "./StatusBar"
import { headLabel, WorktreeTabs } from "./WorktreeTabs"

interface RepoViewProps {
  readonly repo: Repo
  readonly openRepo: OpenRepo | undefined
  readonly preferences: Preferences
  readonly onOpenSettings: () => void
}

/** Everything below the repository tabs for one repository. */
export const RepoView = ({ repo, openRepo, preferences, onOpenSettings }: RepoViewProps) => {
  const run = useRun()
  const id: RepoId = repo.id
  const { data: worktrees } = useLiveQuery({ query: (q) => q.from({ worktree: worktreesCollection(id) }) })
  const { data: refs } = useLiveQuery({ query: (q) => q.from({ ref: refsCollection(id) }) })
  const { data: remotes } = useLiveQuery({ query: (q) => q.from({ remote: remotesCollection(id) }) })
  const { data: views } = useLiveQuery({ query: (q) => q.from({ view: graphViewsCollection(id) }) })
  const view = views[0]

  const sortedWorktrees = useMemo(
    () => [...worktrees].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.path.localeCompare(b.path)),
    [worktrees],
  )
  const sortedRemotes = useMemo(() => [...remotes].sort((a, b) => a.name.localeCompare(b.name)), [remotes])
  const refsById = useMemo(() => new Map<string, Ref>(refs.map((ref) => [ref.id, ref])), [refs])

  const activeWorktree =
    sortedWorktrees.find((wt) => wt.id === openRepo?.activeWorktreeId) ??
    sortedWorktrees.find((wt) => wt.id === repo.mainWorktreeId) ??
    sortedWorktrees[0]
  const headRef = activeWorktree?.head.kind === "branch" ? activeWorktree.head.refId : undefined
  const emphasized = (openRepo?.emphasizedRefId && refsById.has(openRepo.emphasizedRefId) ? openRepo.emphasizedRefId : undefined) ?? headRef
  const headOids = useMemo(() => new Set(worktrees.map((wt) => wt.head.oid)), [worktrees])

  const [selected, setSelected] = useState<LoadedRow>()
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>()

  const emphasize = useCallback(
    (ref: Ref) =>
      void run(Commands.use((commands) => commands.emphasize(id, ref.id))).then((row) => {
        if (row !== undefined && row >= 0) setScrollRequest({ row, nonce: Date.now() })
      }),
    [run, id],
  )

  const selectWorktree = (worktree: Worktree) => {
    void run(Commands.use((commands) => commands.selectWorktree(id, worktree.id)))
    if (worktree.head.kind === "branch" && worktree.head.refId) {
      const ref = refsById.get(worktree.head.refId)
      if (ref) emphasize(ref)
    }
  }

  const emphasizedRef = emphasized ? refsById.get(emphasized) : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorktreeTabs worktrees={sortedWorktrees} refsById={refsById} active={activeWorktree?.id} onSelect={selectWorktree} />
      <div className="flex min-h-0 flex-1">
        <RefNav
          refs={refs}
          remotes={sortedRemotes}
          worktrees={worktrees}
          activeWorktree={activeWorktree?.id}
          emphasized={emphasized}
          onEmphasize={emphasize}
          onCheckout={emphasize}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2.5 border-b px-3.5 py-2 text-xs text-secondary-foreground">
            {emphasizedRef ? (
              <>
                <span>Emphasized</span>
                <span className="rounded bg-primary/20 px-2 py-0.5 font-medium text-primary">
                  {emphasizedRef.shortName}
                </span>
                <span className="text-subtle-foreground">First-parent history at full strength, other threads dimmed</span>
              </>
            ) : (
              <span className="text-subtle-foreground">Click a branch to emphasize its history</span>
            )}
            <div className="flex-1" />
            {view && (
              <span className="font-mono text-subtle-foreground">
                {view.totalRows.toLocaleString()} commits{view.complete ? "" : " (loading…)"}
              </span>
            )}
          </div>
          {view ? (
            <GraphPane
              repo={id}
              view={view}
              emphasized={emphasized}
              refsById={refsById}
              headOids={headOids}
              headRef={headRef}
              selected={selected}
              onSelect={setSelected}
              scrollRequest={scrollRequest}
              preferences={preferences}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-subtle-foreground">
              {repo.state === "error" ? repo.error : "Reading history…"}
            </div>
          )}
        </main>
        <DetailsPanel repo={id} selected={selected} worktree={activeWorktree?.id} preferences={preferences} />
      </div>
      <StatusBar onOpenSettings={onOpenSettings}>
        <span className="flex items-center gap-1.5">
          <span className="size-[7px] rounded-full bg-success" />
          Watching {worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}
        </span>
        {activeWorktree && (
          <span>
            {baseName(activeWorktree.path)} on {headLabel(activeWorktree, refsById)}
          </span>
        )}
      </StatusBar>
    </div>
  )
}
