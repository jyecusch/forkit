import { useLiveQuery } from "@tanstack/react-db"
import { Option } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toggleDetails, useDetailsShown } from "@/app/detailsShown"
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
import { DiffView, type DiffTarget } from "./DiffView"
import { GraphPane, type ScrollRequest } from "./GraphPane"
import { RepoNav } from "./RepoNav"
import { ChromeLayer } from "./Chrome"
import { SidebarFooter } from "./SidebarFooter"
import { NewWorktreeDialog } from "./NewWorktreeDialog"
import { Prompt, type PromptSpec } from "./Prompt"
import { useCheckout } from "./useCheckout"
import { ViewHeader } from "./ViewHeader"

interface RepoViewProps {
  readonly repo: Repo
  readonly openRepo: OpenRepo | undefined
  readonly preferences: Preferences
  /** Whether this is the repository on screen; the others are kept, hidden. */
  readonly active: boolean
}

/** Everything below the repository tabs for one repository. */
export const RepoView = ({ repo, openRepo, preferences, active }: RepoViewProps) => {
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
  // A file's diff, shown in place of the history until closed.
  const [openDiff, setOpenDiff] = useState<DiffTarget>()
  // Escape returns to the history from anywhere in the repository, unless a
  // dialog or menu is open or a field is being typed in.
  useEffect(() => {
    if (!active || !openDiff) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key !== "Escape" || event.defaultPrevented || ["INPUT", "TEXTAREA"].includes(target.tagName)) return
      if (document.querySelector("[role=dialog][data-state=open], [role=menu]")) return
      setOpenDiff(undefined)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, openDiff])
  const diffRevision = worktrees.find((wt) => wt.id === openDiff?.request.worktreeId)?.statusSummary.revision ?? 0
  // Dialogs belong to the repository on screen.
  useEffect(() => {
    if (active) return
    setPrompt(undefined)
    setNewWorktreeBase(undefined)
  }, [active])
  const showDetails = useDetailsShown()

  // Jumping to a ref or worktree returns from a diff to the history.
  const scrollTo = useCallback((row: Option.Option<Option.Option<number>>) => {
    const index = Option.flatten(row)
    if (Option.isSome(index)) {
      setScrollRequest({ row: index.value, nonce: Date.now() })
      setOpenDiff(undefined)
    }
  }, [])

  const emphasize = useCallback(
    (ref: Ref) => void run(Commands.use((commands) => commands.emphasize(id, ref.id))).then(scrollTo),
    [run, id, scrollTo],
  )

  const selectWorktree = (worktree: Worktree) =>
    void run(Commands.use((commands) => commands.selectWorktree(id, worktree))).then(scrollTo)

  // Open on the checked-out commit, wherever it is in the history.
  const viewLoaded = view !== undefined
  const located = useRef(false)
  useEffect(() => {
    if (located.current || !viewLoaded || !headRef) return
    located.current = true
    void run(Commands.use((commands) => commands.locate(id, headRef))).then(scrollTo)
  }, [viewLoaded, headRef, id, run, scrollTo])

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
        active={active}
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
    <ChromeLayer active={active} sidebar={sidebar}>
      <ViewHeader
        worktree={activeWorktree}
        refsById={refsById}
        headEmphasized={emphasized !== undefined && emphasized === headRef}
        emphasizedOther={emphasizedOther}
        onClearEmphasis={() => headBranch && emphasize(headBranch)}
        view={view}
        checkingOut={running.some((op) => op.kind === "checkout")}
        detailsShown={showDetails}
        onToggleDetails={toggleDetails}
      />
      <div className="flex min-h-0 flex-1">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {view ? (
            <div className="flex min-h-0 flex-1 flex-col" inert={openDiff !== undefined}>
              <GraphPane
                repo={id}
                view={view}
                emphasized={emphasized}
                refsById={refsById}
                headOids={headOids}
                headRef={headRef}
                selected={selected}
                activeHead={activeWorktree?.head.oid}
                onSelect={setSelected}
                scrollRequest={scrollRequest}
                active={active}
                preferences={preferences}
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-subtle-foreground">
              {repo.state === "error" ? repo.error : "Reading history…"}
            </div>
          )}
          {openDiff && (
            <DiffView
              repo={id}
              target={openDiff}
              revision={diffRevision}
              active={active}
              onClose={() => setOpenDiff(undefined)}
            />
          )}
        </main>
        {showDetails && (
          <DetailsPanel
            repo={id}
            selected={selected}
            worktree={activeWorktree?.id}
            changes={activeWorktree ? changeCount(activeWorktree) : 0}
            preferences={preferences}
            openDiff={openDiff}
            onOpenDiff={setOpenDiff}
          />
        )}
      </div>
      <Prompt spec={prompt} onClose={() => setPrompt(undefined)} />
      <NewWorktreeDialog repo={repo} base={newWorktreeBase} onClose={() => setNewWorktreeBase(undefined)} />
    </ChromeLayer>
  )
}

const operationLabels: Record<OperationKind, string> = {
  checkout: "Checking out",
  createWorktree: "Creating worktree",
  removeWorktree: "Removing worktree",
}
