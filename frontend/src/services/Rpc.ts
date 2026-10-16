import { Context, Effect, Layer, Option, Schema, type Tracer } from "effect"
import { fromRejection, type RpcFailure } from "@/model/errors"
import {
  ApplyStashResult,
  CheckoutResult,
  CommitDetail,
  FileDiff,
  GraphWindow,
  InitRepoResult,
  Oid,
  Repo,
  SyncSnapshot,
  Worktree,
  type CheckoutMode,
  type DiffRequest,
  type LayoutSize,
  type RefId,
  type RepoId,
  type WorktreeId,
} from "@/model/model.gen"
import { model } from "@/wailsjs/go/models"
import * as Avatars from "@/wailsjs/go/rpc/Avatars"
import * as Preferences from "@/wailsjs/go/rpc/Preferences"
import * as Repos from "@/wailsjs/go/rpc/Repos"
import * as Session from "@/wailsjs/go/rpc/Session"
import * as Sync from "@/wailsjs/go/rpc/Sync"
import * as Worktrees from "@/wailsjs/go/rpc/Worktrees"

/** Typed, traced access to the backend's bound services. */
export class Rpc extends Context.Service<
  Rpc,
  {
    readonly subscribe: (channel: string, scope: string) => Effect.Effect<SyncSnapshot, RpcFailure>
    readonly openRepo: (path: string) => Effect.Effect<Repo, RpcFailure>
    /** Resolves to None when the user cancels the folder picker. */
    readonly chooseAndOpenRepo: () => Effect.Effect<Option.Option<Repo>, RpcFailure>
    /** Asks for a folder, makes it a new repository and opens it; none when the user cancels. */
    readonly chooseAndInitRepo: () => Effect.Effect<Option.Option<InitRepoResult>, RpcFailure>
    readonly closeRepo: (id: RepoId) => Effect.Effect<void, RpcFailure>
    /** Clones url into path, which must not exist yet, and opens it. */
    readonly cloneRepo: (url: string, path: string) => Effect.Effect<Repo, RpcFailure>
    readonly cancelClone: (path: string) => Effect.Effect<void, RpcFailure>
    /** Resolves to None when the user cancels the folder picker. */
    readonly chooseCloneDirectory: () => Effect.Effect<Option.Option<string>, RpcFailure>
    readonly graphWindow: (
      id: RepoId,
      start: number,
      count: number,
      emphasized: RefId | undefined,
    ) => Effect.Effect<GraphWindow, RpcFailure>
    readonly rowOfRef: (id: RepoId, ref: RefId) => Effect.Effect<number, RpcFailure>
    readonly commitDetail: (id: RepoId, oid: Oid) => Effect.Effect<CommitDetail, RpcFailure>
    readonly diff: (id: RepoId, request: DiffRequest) => Effect.Effect<FileDiff, RpcFailure>
    readonly setPreference: (path: string, value: unknown) => Effect.Effect<void, RpcFailure>
    readonly resetPreference: (path: string) => Effect.Effect<void, RpcFailure>
    readonly setActiveRepo: (id: RepoId) => Effect.Effect<void, RpcFailure>
    readonly showNewTab: () => Effect.Effect<void, RpcFailure>
    readonly reorderRepos: (ids: ReadonlyArray<RepoId>) => Effect.Effect<void, RpcFailure>
    readonly setActiveWorktree: (repo: RepoId, worktree: WorktreeId) => Effect.Effect<void, RpcFailure>
    readonly setEmphasizedRef: (repo: RepoId, ref: RefId) => Effect.Effect<void, RpcFailure>
    /** Remembers a panel or column's size; resetting lets it be chosen automatically again. */
    readonly setLayoutSize: (name: LayoutSize, size: number) => Effect.Effect<void, RpcFailure>
    readonly resetLayoutSize: (name: LayoutSize) => Effect.Effect<void, RpcFailure>
    readonly checkout: (worktree: WorktreeId, ref: RefId, mode: CheckoutMode) => Effect.Effect<CheckoutResult, RpcFailure>
    /** An empty newBranch checks out base itself; an empty path lets the backend choose. */
    readonly createWorktree: (repo: RepoId, base: RefId, newBranch: string, path: string) => Effect.Effect<Worktree, RpcFailure>
    readonly removeWorktree: (worktree: WorktreeId, force: boolean) => Effect.Effect<void, RpcFailure>
    readonly stage: (worktree: WorktreeId, paths: ReadonlyArray<string>) => Effect.Effect<void, RpcFailure>
    readonly unstage: (worktree: WorktreeId, paths: ReadonlyArray<string>) => Effect.Effect<void, RpcFailure>
    /** Commits the staged changes, or amends the last commit, and returns the new commit. */
    readonly commit: (worktree: WorktreeId, message: string, amend: boolean) => Effect.Effect<Oid, RpcFailure>
    readonly headMessage: (worktree: WorktreeId) => Effect.Effect<string, RpcFailure>
    /** Fetches from remote, or from every remote when it is empty. */
    readonly fetch: (repo: RepoId, remote: string) => Effect.Effect<void, RpcFailure>
    readonly pull: (worktree: WorktreeId) => Effect.Effect<void, RpcFailure>
    /** Pushes to the branch's upstream, or publishes it to remote when it has none. */
    readonly push: (worktree: WorktreeId, remote: string, force: boolean) => Effect.Effect<void, RpcFailure>
    /** Deletes local branches, merged or not, and remote branches from their remotes. */
    readonly deleteBranches: (repo: RepoId, refs: ReadonlyArray<RefId>) => Effect.Effect<void, RpcFailure>
    /** Stashes a worktree's uncommitted changes, untracked files included; an empty message lets git name it. */
    readonly stash: (worktree: WorktreeId, message: string) => Effect.Effect<void, RpcFailure>
    /** Applies a stash to a worktree, and with pop drops it unless its changes conflicted. */
    readonly applyStash: (worktree: WorktreeId, stash: RefId, pop: boolean) => Effect.Effect<ApplyStashResult, RpcFailure>
    readonly dropStash: (repo: RepoId, stash: RefId) => Effect.Effect<void, RpcFailure>
    readonly cancelOperation: (repo: RepoId, operation: string) => Effect.Effect<void, RpcFailure>
    /** An author's Gravatar picture as a data URL, or "" when there is none or Gravatar is turned off. */
    readonly gravatar: (email: string) => Effect.Effect<string, RpcFailure>
    /** Resolves to None when the user cancels the folder picker. */
    readonly chooseWorktreeParent: () => Effect.Effect<Option.Option<string>, RpcFailure>
  }
>()("forkit/Rpc") {
  static readonly layer = Layer.succeed(Rpc, {
    subscribe: (channel, scope) =>
      invoke("Sync.Subscribe", SyncSnapshot, (meta) => Sync.Subscribe(meta, channel, scope), {
        "sync.channel": channel,
        "sync.scope": scope,
      }),
    openRepo: (path) => invoke("Repos.Open", Repo, (meta) => Repos.Open(meta, path)),
    chooseAndOpenRepo: () =>
      invoke("Repos.ChooseAndOpen", Schema.NullOr(Repo), (meta) => Repos.ChooseAndOpen(meta)).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    chooseAndInitRepo: () =>
      invoke("Repos.ChooseAndInit", Schema.NullOr(InitRepoResult), (meta) => Repos.ChooseAndInit(meta)).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    closeRepo: (id) => invoke("Repos.Close", Schema.Void, (meta) => Repos.Close(meta, id), { "repo.id": id }),
    cloneRepo: (url, path) => invoke("Repos.Clone", Repo, (meta) => Repos.Clone(meta, url, path)),
    cancelClone: (path) => invoke("Repos.CancelClone", Schema.Void, (meta) => Repos.CancelClone(meta, path)),
    chooseCloneDirectory: () =>
      invoke("Repos.ChooseCloneDirectory", Schema.String, (meta) => Repos.ChooseCloneDirectory(meta)).pipe(
        Effect.map((path) => (path === "" ? Option.none() : Option.some(path))),
      ),
    graphWindow: (id, start, count, emphasized) =>
      invoke("Repos.GraphWindow", GraphWindow, (meta) => Repos.GraphWindow(meta, id, start, count, emphasized ?? ""), {
        "repo.id": id,
        "rows.start": start,
        "rows.requested": count,
      }),
    rowOfRef: (id, ref) => invoke("Repos.RowOfRef", Schema.Int, (meta) => Repos.RowOfRef(meta, id, ref), { "repo.id": id }),
    commitDetail: (id, oid) =>
      invoke("Repos.CommitDetail", CommitDetail, (meta) => Repos.CommitDetail(meta, id, oid), { "repo.id": id }),
    diff: (id, request) =>
      invoke("Repos.Diff", FileDiff, (meta) => Repos.Diff(meta, id, model.DiffRequest.createFrom(request)), {
        "repo.id": id,
        "diff.kind": request.kind,
      }),
    setPreference: (path, value) =>
      invoke("Preferences.Set", Schema.Void, (meta) => Preferences.Set(meta, path, value), { "preference.path": path }),
    resetPreference: (path) =>
      invoke("Preferences.Reset", Schema.Void, (meta) => Preferences.Reset(meta, path), { "preference.path": path }),
    setActiveRepo: (id) => invoke("Session.SetActiveRepo", Schema.Void, (meta) => Session.SetActiveRepo(meta, id)),
    showNewTab: () => invoke("Session.ShowNewTab", Schema.Void, (meta) => Session.ShowNewTab(meta)),
    reorderRepos: (ids) =>
      invoke("Session.ReorderRepos", Schema.Void, (meta) => Session.ReorderRepos(meta, [...ids])),
    setActiveWorktree: (repo, worktree) =>
      invoke("Session.SetActiveWorktree", Schema.Void, (meta) => Session.SetActiveWorktree(meta, repo, worktree)),
    setLayoutSize: (name, size) =>
      invoke("Session.SetLayoutSize", Schema.Void, (meta) => Session.SetLayoutSize(meta, name, size), { "layout.name": name }),
    resetLayoutSize: (name) =>
      invoke("Session.ResetLayoutSize", Schema.Void, (meta) => Session.ResetLayoutSize(meta, name), { "layout.name": name }),
    setEmphasizedRef: (repo, ref) =>
      invoke("Session.SetEmphasizedRef", Schema.Void, (meta) => Session.SetEmphasizedRef(meta, repo, ref)),
    checkout: (worktree, ref, mode) =>
      invoke("Worktrees.Checkout", CheckoutResult, (meta) => Worktrees.Checkout(meta, worktree, ref, mode), {
        "worktree.id": worktree,
        "checkout.mode": mode,
      }),
    createWorktree: (repo, base, newBranch, path) =>
      invoke("Worktrees.Create", Worktree, (meta) => Worktrees.Create(meta, repo, base, newBranch, path), { "repo.id": repo }),
    stage: (worktree, paths) =>
      invoke("Worktrees.Stage", Schema.Void, (meta) => Worktrees.Stage(meta, worktree, [...paths]), { "worktree.id": worktree }),
    unstage: (worktree, paths) =>
      invoke("Worktrees.Unstage", Schema.Void, (meta) => Worktrees.Unstage(meta, worktree, [...paths]), { "worktree.id": worktree }),
    commit: (worktree, message, amend) =>
      invoke("Worktrees.Commit", Oid, (meta) => Worktrees.Commit(meta, worktree, message, amend), { "worktree.id": worktree }),
    headMessage: (worktree) =>
      invoke("Worktrees.HeadMessage", Schema.String, (meta) => Worktrees.HeadMessage(meta, worktree), { "worktree.id": worktree }),
    removeWorktree: (worktree, force) =>
      invoke("Worktrees.Remove", Schema.Void, (meta) => Worktrees.Remove(meta, worktree, force), { "worktree.id": worktree }),
    fetch: (repo, remote) => invoke("Repos.Fetch", Schema.Void, (meta) => Repos.Fetch(meta, repo, remote), { "repo.id": repo }),
    pull: (worktree) => invoke("Worktrees.Pull", Schema.Void, (meta) => Worktrees.Pull(meta, worktree), { "worktree.id": worktree }),
    push: (worktree, remote, force) =>
      invoke("Worktrees.Push", Schema.Void, (meta) => Worktrees.Push(meta, worktree, remote, force), {
        "worktree.id": worktree,
        "push.force": force,
      }),
    stash: (worktree, message) =>
      invoke("Worktrees.Stash", Schema.Void, (meta) => Worktrees.Stash(meta, worktree, message), { "worktree.id": worktree }),
    applyStash: (worktree, stash, pop) =>
      invoke("Worktrees.ApplyStash", ApplyStashResult, (meta) => Worktrees.ApplyStash(meta, worktree, stash, pop), {
        "worktree.id": worktree,
        "stash.pop": pop,
      }),
    dropStash: (repo, stash) =>
      invoke("Repos.DropStash", Schema.Void, (meta) => Repos.DropStash(meta, repo, stash), { "repo.id": repo }),
    gravatar: (email) => invoke("Avatars.Gravatar", Schema.String, (meta) => Avatars.Gravatar(meta, email)),
    deleteBranches: (repo, refs) =>
      invoke("Repos.DeleteBranches", Schema.Void, (meta) => Repos.DeleteBranches(meta, repo, [...refs]), {
        "repo.id": repo,
        "branches.count": refs.length,
      }),
    cancelOperation: (repo, operation) =>
      invoke("Repos.CancelOperation", Schema.Void, (meta) => Repos.CancelOperation(meta, repo, operation), { "repo.id": repo }),
    chooseWorktreeParent: () =>
      invoke("Worktrees.ChooseParentDirectory", Schema.String, (meta) => Worktrees.ChooseParentDirectory(meta)).pipe(
        Effect.map((path) => (path === "" ? Option.none() : Option.some(path))),
      ),
  })
}

/**
 * Calls a binding inside a client span whose context is passed to the
 * backend, and decodes the result. A result that does not match its schema
 * means the two sides disagree about the contract, which is a bug.
 */
const invoke = <S extends Schema.Top>(
  method: string,
  result: S,
  call: (meta: model.CallMeta) => Promise<unknown>,
  attributes: Record<string, unknown> = {},
): Effect.Effect<S["Type"], RpcFailure, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const span = yield* Effect.orDie(Effect.currentSpan)
    const meta = model.CallMeta.createFrom({ traceparent: traceparent(span) })
    const raw = yield* Effect.tryPromise({ try: () => call(meta), catch: fromRejection })
    return yield* Effect.orDie(Schema.decodeUnknownEffect(result)(raw))
  }).pipe(Effect.withSpan(`rpc ${method}`, { kind: "client", attributes: { "rpc.method": method, ...attributes } }))

export const traceparent = (span: Tracer.Span): string =>
  `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`
