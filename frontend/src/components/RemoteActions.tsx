import { Effect } from "effect"
import { ArrowDown, ArrowUp, LoaderCircle, RefreshCw } from "lucide-react"
import type { ReactNode } from "react"
import { useRun } from "@/app/hooks"
import { notify } from "@/app/notifications"
import { setPreferencesOpen } from "@/app/preferencesDialog"
import { useNow } from "@/app/useNow"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BackendError, RpcFailure } from "@/model/errors"
import type { Operation, Ref, Remote, RepoId, Worktree } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import type { PromptSpec } from "./Prompt"

interface RemoteActionsProps {
  readonly repo: RepoId
  readonly worktree: Worktree | undefined
  /** The checked-out branch, and the branch it tracks. */
  readonly branch: Ref | undefined
  readonly upstream: Ref | undefined
  readonly remotes: ReadonlyArray<Remote>
  readonly operations: ReadonlyArray<Operation>
  readonly prompt: (spec: PromptSpec) => void
  readonly onShowChanges: () => void
}

/**
 * Fetch, pull and push for the checked-out branch. Pull counts what the
 * upstream has that the branch lacks and push what the branch has that the
 * upstream lacks. A running action shows its progress, and clicking it
 * again cancels it.
 */
export const RemoteActions = ({ repo, worktree, branch, upstream, remotes, operations, prompt, onShowChanges }: RemoteActionsProps) => {
  const run = useRun()
  const now = useNow()
  const running = (kind: Operation["kind"]) =>
    operations.find((op) => op.state === "running" && op.kind === kind && (kind === "fetch" || op.worktreeId === worktree?.id))
  const fetching = running("fetch")
  const pulling = running("pull")
  const pushing = running("push")
  const busy = operations.some((op) => op.state === "running" && op.worktreeId === worktree?.id)

  const cancel = (op: Operation) => void run(Commands.use((commands) => commands.cancelOperation(repo, op.id)))
  const report = (effect: Effect.Effect<void, RpcFailure, Commands>, done: () => void, handle: (error: BackendError) => boolean = () => false) =>
    void run(
      effect.pipe(
        Effect.tap(() => Effect.sync(done)),
        Effect.catchTags({
          OperationInProgressError: (error) =>
            Effect.sync(() => notify({ tone: "error", message: error.message, action: { label: "Show changes", run: onShowChanges } })),
          BackendError: (error) =>
            error.code === "Cancelled" || handle(error) ? Effect.void : Effect.sync(() => notify({ tone: "error", message: error.message })),
        }),
      ),
    )

  const fetch = () => report(Commands.use((commands) => commands.fetch(repo, "")), () => {})

  const pull = () => {
    if (!worktree || !branch || !upstream) return
    const behind = branch.behind ?? 0
    report(
      Commands.use((commands) => commands.pull(worktree.id)),
      () =>
        notify({
          tone: "info",
          message: behind > 0 ? `Pulled ${behind} ${behind === 1 ? "commit" : "commits"} into ${branch.shortName}` : `${branch.shortName} is up to date`,
          duration: 2500,
        }),
      (error) => {
        if (error.code !== "Diverged") return false
        notify({ tone: "error", message: error.message, action: { label: "Open settings", run: () => setPreferencesOpen(true) } })
        return true
      },
    )
  }

  /** Pushes to the upstream, or with remote set, publishes the branch there. */
  const push = (remote: string, force: boolean) => {
    if (!worktree || !branch) return
    const target = remote ? `${remote}/${branch.shortName}` : (upstream?.shortName ?? branch.shortName)
    report(
      Commands.use((commands) => commands.push(worktree.id, remote, force)),
      () => notify({ tone: "info", message: `${remote ? "Published" : "Pushed"} ${branch.shortName} to ${target}`, duration: 2500 }),
      (error) => {
        if (error.code !== "PushRejected" || error.details["stale"]) return false
        notify({
          tone: "error",
          message: error.message,
          action: {
            label: "Force push…",
            run: () =>
              prompt({
                title: `Force push ${branch.shortName}?`,
                message: `${target} will be replaced with your ${branch.shortName}, dropping the commits there that aren't in yours. It is refused if ${target} has changed since it was last fetched.`,
                actions: [{ label: "Force push", tone: "destructive", run: () => push(remote, true) }],
              }),
          },
        })
        return true
      },
    )
  }

  const publish = () => {
    if (!branch) return
    const only = remotes.length === 1 ? remotes[0] : remotes.find((remote) => remote.name === "origin")
    if (only) return push(only.name, false)
    prompt({
      title: `Publish ${branch.shortName}?`,
      message: `Choose the remote to push ${branch.shortName} to. It will track the branch it creates there.`,
      actions: remotes.map((remote) => ({ label: remote.name, run: () => push(remote.name, false) })),
    })
  }

  const fetchedAt = remotes.reduce<number | undefined>(
    (oldest, remote) => (remote.lastFetchedAt === undefined ? oldest : Math.min(oldest ?? Infinity, remote.lastFetchedAt)),
    undefined,
  )
  const failed = remotes.filter((remote) => remote.fetchState === "error")
  const noBranch = branch ? undefined : "Check out a branch to pull or push"
  const ahead = branch?.ahead ?? 0
  const behind = branch?.behind ?? 0

  if (remotes.length === 0) return null
  return (
    <div className="flex flex-none items-center gap-0.5">
      <ActionButton
        label="Fetch"
        title={[
          fetching ? "Cancel fetch" : `Fetch from ${remotes.length === 1 ? remotes[0]!.name : "every remote"}`,
          fetchedAt !== undefined && `Last fetched ${formatDate(fetchedAt, "relative", now)}`,
          failed.length > 0 && `Fetching from ${failed.map((remote) => remote.name).join(", ")} failed`,
        ]
          .filter(Boolean)
          .join("\n")}
        operation={fetching}
        onClick={() => (fetching ? cancel(fetching) : fetch())}
        icon={
          <span className="relative flex">
            <RefreshCw className={cn("size-3.5", remotes.some((remote) => remote.fetchState === "fetching") && "animate-spin")} />
            {failed.length > 0 && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive" />}
          </span>
        }
      />
      <ActionButton
        label="Pull"
        title={pulling ? "Cancel pull" : (noBranch ?? (upstream ? `Pull from ${upstream.shortName}` : `${branch!.shortName} has no upstream branch to pull from`))}
        disabled={!pulling && (!upstream || busy)}
        operation={pulling}
        onClick={() => (pulling ? cancel(pulling) : pull())}
        icon={<ArrowDown className="size-3.5" />}
      >
        {behind > 0 && <span className="text-warning">{behind}</span>}
      </ActionButton>
      <ActionButton
        label={upstream ? "Push" : "Publish"}
        title={pushing ? "Cancel push" : (noBranch ?? (upstream ? `Push to ${upstream.shortName}` : `Publish ${branch!.shortName} to a remote`))}
        disabled={!pushing && (!branch || busy)}
        operation={pushing}
        onClick={() => (pushing ? cancel(pushing) : upstream ? push("", false) : publish())}
        icon={<ArrowUp className="size-3.5" />}
      >
        {upstream ? ahead > 0 && <span className="text-success">{ahead}</span> : branch && <span>Publish</span>}
      </ActionButton>
    </div>
  )
}

interface ActionButtonProps {
  readonly label: string
  readonly title: string
  readonly icon: ReactNode
  /** While set, the button shows its progress and clicking it cancels it. */
  readonly operation: Operation | undefined
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children?: ReactNode
}

const ActionButton = ({ label, title, icon, operation, disabled = false, onClick, children }: ActionButtonProps) => {
  const progress = operation?.progress
  return (
    <button
      aria-label={operation ? `Cancel ${label.toLowerCase()}` : label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 tabular-nums hover:bg-foreground/[0.05] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {operation ? <LoaderCircle className="size-3.5 animate-spin text-primary" /> : icon}
      {operation
        ? progress && progress.total > 0 && <span className="text-primary">{Math.floor((progress.current / progress.total) * 100)}%</span>
        : children}
    </button>
  )
}
