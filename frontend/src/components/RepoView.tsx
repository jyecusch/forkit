import { useLiveQuery } from "@tanstack/react-db"
import { Option } from "effect"
import { useCallback, useMemo, useState } from "react"
import { useMediaQuery, useRun } from "@/app/hooks"
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
import { RepoNav } from "./RepoNav"
import { Chrome } from "./Chrome"
import { RepoTabs } from "./RepoTabs"
import { SidebarFooter } from "./SidebarFooter"
import { NewWorktreeDialog } from "./NewWorktreeDialog"
import { Prompt, type PromptSpec } from "./Prompt"
import { useCheckout } from "./useCheckout"
import { ViewHeader } from "./ViewHeader"

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
  // The details panel follows the window's width until it is toggled.
  const wide = useMediaQuery("(min-width: 1000px)", true)
  const [detailsToggled, setDetailsToggled] = useState<boolean>()
  const showDetails = detailsToggled ?? wide

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

  const headBranch = headRef ? refsById.get(headRef) : undefined
  const emphasizedOther = emphasized && emphasized !== headRef ? refsById.get(emphasized) : undefined
  const reveal = useMemo(() => [headRef, emphasized].filter((ref): ref is NonNullable<typeof ref> => ref !== undefined), [headRef, emphasized])

  const sidebar = (
    <>
      <RepoNav
        refs={refs}
        remotes={remotes}
        worktrees={worktrees}
        activeWorktree={activeWorktree?.id}
        emphasized={emphasized}
        reveal={reveal}
        onEmphasize={emphasize}
        onCheckout={(ref) => checkout(ref, activeWorktree)}
        onNewWorktree={(base) => setNewWorktreeBase(base ?? headBranch ?? refs.find((ref) => ref.kind === "localBranch"))}
        onSelectWorktree={selectWorktree}
        onRemoveWorktree={removeWorktree}
      />
      <SidebarFooter>
        {running.length > 0 && <span className="animate-pulse truncate text-primary">{operationLabels[running[0]!.kind]}…</span>}
      </SidebarFooter>
    </>
  )
  return (
    <Chrome sidebar={sidebar} tabs={<RepoTabs />}>
      <ViewHeader
        worktree={activeWorktree}
        refsById={refsById}
        emphasizedOther={emphasizedOther}
        onClearEmphasis={() => headBranch && emphasize(headBranch)}
        view={view}
        checkingOut={running.some((op) => op.kind === "checkout")}
        detailsShown={showDetails}
        onToggleDetails={() => setDetailsToggled(!showDetails)}
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
              defaultSelection={activeWorktree?.head.oid}
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
        {showDetails && (
          <DetailsPanel
            repo={id}
            selected={selected}
            worktree={activeWorktree?.id}
            changes={activeWorktree ? changeCount(activeWorktree) : 0}
            preferences={preferences}
          />
        )}
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
