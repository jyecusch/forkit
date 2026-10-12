import { useLiveQuery } from "@tanstack/react-db"
import { Option } from "effect"
import { useCallback, useMemo, useState } from "react"
import { useRun } from "@/app/hooks"
import {
  graphViewsCollection,
  operationsCollection,
  refsCollection,
  remotesCollection,
  worktreesCollection,
} from "@/data/collections"
import { baseName } from "@/lib/format"
import { changeCount } from "@/lib/worktree"
import type { OpenRepo, OperationKind, Preferences, Ref, Repo, RepoId, Worktree } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import type { LoadedRow } from "@/services/GraphData"
import { DetailsPanel } from "./DetailsPanel"
import { GraphPane, type ScrollRequest } from "./GraphPane"
import { RefNav } from "./RefNav"
import { StatusBar } from "./StatusBar"
import { NewWorktreeDialog } from "./NewWorktreeDialog"
import { Prompt, type PromptSpec } from "./Prompt"
import { useCheckout } from "./useCheckout"
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
  const { data: operations } = useLiveQuery({ query: (q) => q.from({ operation: operationsCollection(id) }) })
  const running = operations.filter((op) => op.state === "running")

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
  const [prompt, setPrompt] = useState<PromptSpec>()
  const [newWorktreeBase, setNewWorktreeBase] = useState<Ref>()
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>()

  const scrollTo = useCallback((row: Option.Option<Option.Option<number>>) => {
    const index = Option.flatten(row)
    if (Option.isSome(index)) setScrollRequest({ row: index.value, nonce: Date.now() })
  }, [])

  const emphasize = useCallback(
    (ref: Ref) => void run(Commands.use((commands) => commands.emphasize(id, ref.id))).then(scrollTo),
    [run, id, scrollTo],
  )

  const selectWorktree = (worktree: Worktree) =>
    void run(Commands.use((commands) => commands.selectWorktree(id, worktree))).then(scrollTo)

  const checkout = useCheckout({
    repo: id,
    refs,
    worktrees,
    dirtyCheckout: preferences.behaviour.dirtyCheckout,
    prompt: setPrompt,
    selectWorktree,
  })

  const removeWorktree = (worktree: Worktree) => {
    const dirty = changeCount(worktree) > 0
    setPrompt({
      title: `Remove worktree ${baseName(worktree.path)}?`,
      message: dirty
        ? `Its folder will be deleted, including ${changeCount(worktree)} uncommitted changes. Its branch is kept.`
        : "Its folder will be deleted. Its branch is kept.",
      actions: [
        {
          label: "Remove",
          tone: "destructive",
          run: () => void run(Commands.use((commands) => commands.removeWorktree(worktree.id, dirty))),
        },
      ],
    })
  }

  const emphasizedRef = emphasized ? refsById.get(emphasized) : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorktreeTabs
        worktrees={sortedWorktrees}
        refsById={refsById}
        active={activeWorktree?.id}
        onSelect={selectWorktree}
        onCreate={() => setNewWorktreeBase(emphasizedRef ?? (headRef ? refsById.get(headRef) : undefined))}
        onRemove={removeWorktree}
      />
      <div className="flex min-h-0 flex-1">
        <RefNav
          refs={refs}
          remotes={sortedRemotes}
          worktrees={worktrees}
          activeWorktree={activeWorktree?.id}
          emphasized={emphasized}
          onEmphasize={emphasize}
          onCheckout={(ref) => checkout(ref, activeWorktree)}
          onNewWorktree={setNewWorktreeBase}
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
        {running.map((op) => (
          <span key={op.id} className="animate-pulse text-primary">
            {operationLabels[op.kind]}…
          </span>
        ))}
        {activeWorktree && (
          <span>
            {baseName(activeWorktree.path)} on {headLabel(activeWorktree, refsById)}
          </span>
        )}
      </StatusBar>
      <Prompt spec={prompt} onClose={() => setPrompt(undefined)} />
      <NewWorktreeDialog repo={repo} base={newWorktreeBase} onClose={() => setNewWorktreeBase(undefined)} />
    </div>
  )
}

const operationLabels: Record<OperationKind, string> = {
  checkout: "Checking out",
  createWorktree: "Creating worktree",
  removeWorktree: "Removing worktree",
}
