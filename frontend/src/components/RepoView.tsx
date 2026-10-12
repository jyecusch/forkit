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
import { Chrome } from "./Chrome"
import { RepoTabs } from "./RepoTabs"
import { SidebarFooter } from "./SidebarFooter"
import { NewWorktreeDialog } from "./NewWorktreeDialog"
import { Prompt, type PromptSpec } from "./Prompt"
import { useCheckout } from "./useCheckout"
import { headLabel, WorktreeTabs } from "./WorktreeTabs"

interface RepoViewProps {
  readonly repo: Repo
  readonly openRepo: OpenRepo | undefined
  readonly preferences: Preferences
}

/** Everything below the repository tabs for one repository. */
export const RepoView = ({ repo, openRepo, preferences }: RepoViewProps) => {
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
  const sidebar = (
    <>
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
      <SidebarFooter>
        {running.length > 0 ? (
          <span className="animate-pulse truncate text-primary">{operationLabels[running[0]!.kind]}…</span>
        ) : (
          <span className="truncate" title={`Watching ${worktrees.length} ${worktrees.length === 1 ? "worktree" : "worktrees"}`}>
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" />
            {activeWorktree ? `${baseName(activeWorktree.path)} on ${headLabel(activeWorktree, refsById)}` : repo.name}
          </span>
        )}
      </SidebarFooter>
    </>
  )
  return (
    <Chrome sidebar={sidebar} header={<RepoTabs />}>
      <WorktreeTabs
        worktrees={sortedWorktrees}
        refsById={refsById}
        active={activeWorktree?.id}
        onSelect={selectWorktree}
        onCreate={() => setNewWorktreeBase(emphasizedRef ?? (headRef ? refsById.get(headRef) : undefined))}
        onRemove={removeWorktree}
        trailing={
          <div className="flex flex-none items-center gap-3 text-xs whitespace-nowrap text-subtle-foreground">
            {emphasizedRef && (
              <span
                className="flex items-center gap-1.5"
                title="Its first-parent history is drawn at full strength; other history is dimmed"
              >
                <span className="size-1.5 rounded-full bg-primary" />
                <span className="max-w-48 truncate text-secondary-foreground">{emphasizedRef.shortName}</span>
              </span>
            )}
            {view && (
              <span className="tabular-nums">
                {view.totalRows.toLocaleString()} commits{view.complete ? "" : "…"}
              </span>
            )}
          </div>
        }
      />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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
      <Prompt spec={prompt} onClose={() => setPrompt(undefined)} />
      <NewWorktreeDialog repo={repo} base={newWorktreeBase} onClose={() => setNewWorktreeBase(undefined)} />
    </Chrome>
  )
}

const operationLabels: Record<OperationKind, string> = {
  checkout: "Checking out",
  createWorktree: "Creating worktree",
  removeWorktree: "Removing worktree",
}
