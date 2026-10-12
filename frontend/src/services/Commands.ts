import { Context, Effect, Layer, Option } from "effect"
import type { RpcFailure } from "@/model/errors"
import type { CheckoutMode, CheckoutResult, RefId, Repo, RepoId, Worktree, WorktreeId } from "@/model/model.gen"
import { Rpc } from "./Rpc"

/** Actions the user takes. Each runs in its own span. */
export class Commands extends Context.Service<
  Commands,
  {
    /** Asks for a folder and opens it; None if the user cancels. */
    readonly openRepository: () => Effect.Effect<Option.Option<Repo>, RpcFailure>
    readonly closeRepository: (repo: RepoId) => Effect.Effect<void, RpcFailure>
    readonly selectRepository: (repo: RepoId) => Effect.Effect<void, RpcFailure>
    readonly reorderRepositories: (repos: ReadonlyArray<RepoId>) => Effect.Effect<void, RpcFailure>
    /**
     * Makes a worktree active and emphasizes its branch, returning the row
     * of the branch tip to scroll to.
     */
    readonly selectWorktree: (repo: RepoId, worktree: Worktree) => Effect.Effect<Option.Option<number>, RpcFailure>
    /**
     * Makes ref the emphasized history and returns the graph row of its
     * tip, or None when that commit is not shown.
     */
    readonly emphasize: (repo: RepoId, ref: RefId) => Effect.Effect<Option.Option<number>, RpcFailure>
    /** The graph row of the commit a ref points at, if it is in the graph. */
    readonly locate: (repo: RepoId, ref: RefId) => Effect.Effect<Option.Option<number>, RpcFailure>
    /** Checks out ref in a worktree and then emphasizes the branch it lands on. */
    readonly checkout: (
      repo: RepoId,
      worktree: WorktreeId,
      ref: RefId,
      mode: CheckoutMode,
    ) => Effect.Effect<CheckoutResult, RpcFailure>
    /** Creates a worktree, makes it the active one and emphasizes its branch. */
    readonly createWorktree: (repo: RepoId, base: RefId, newBranch: string, path: string) => Effect.Effect<Worktree, RpcFailure>
    readonly removeWorktree: (worktree: WorktreeId, force: boolean) => Effect.Effect<void, RpcFailure>
    readonly chooseWorktreeParent: () => Effect.Effect<Option.Option<string>, RpcFailure>
    /** Fetches from remote, or from every remote when it is empty. */
    readonly fetch: (repo: RepoId, remote: string) => Effect.Effect<void, RpcFailure>
    /** Brings a worktree's branch up to date with its upstream. */
    readonly pull: (worktree: WorktreeId) => Effect.Effect<void, RpcFailure>
    /** Pushes a worktree's branch, publishing it to remote when it has no upstream. */
    readonly push: (worktree: WorktreeId, remote: string, force: boolean) => Effect.Effect<void, RpcFailure>
    readonly cancelOperation: (repo: RepoId, operation: string) => Effect.Effect<void, RpcFailure>
  }
>()("forkit/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const rpc = yield* Rpc
      const emphasize = Effect.fn("command.emphasize")(function* (repo: RepoId, ref: RefId) {
        const [row] = yield* Effect.all([rpc.rowOfRef(repo, ref), rpc.setEmphasizedRef(repo, ref)], {
          concurrency: "unbounded",
        })
        return row >= 0 ? Option.some(row) : Option.none()
      })
      return Commands.of({
        openRepository: Effect.fn("command.openRepository")(function* () {
          return yield* rpc.chooseAndOpenRepo()
        }),
        closeRepository: Effect.fn("command.closeRepository")(function* (repo: RepoId) {
          yield* rpc.closeRepo(repo)
        }),
        selectRepository: Effect.fn("command.selectRepository")(function* (repo: RepoId) {
          yield* rpc.setActiveRepo(repo)
        }),
        reorderRepositories: Effect.fn("command.reorderRepositories")(function* (repos: ReadonlyArray<RepoId>) {
          yield* rpc.reorderRepos(repos)
        }),
        selectWorktree: Effect.fn("command.selectWorktree")(function* (repo: RepoId, worktree: Worktree) {
          yield* rpc.setActiveWorktree(repo, worktree.id)
          return worktree.head.refId ? yield* emphasize(repo, worktree.head.refId) : Option.none()
        }),
        emphasize,
        locate: Effect.fn("command.locate")(function* (repo: RepoId, ref: RefId) {
          const row = yield* rpc.rowOfRef(repo, ref)
          return row >= 0 ? Option.some(row) : Option.none()
        }),
        checkout: Effect.fn("command.checkout")(function* (repo: RepoId, worktree: WorktreeId, ref: RefId, mode: CheckoutMode) {
          const result = yield* rpc.checkout(worktree, ref, mode)
          yield* rpc.setEmphasizedRef(repo, result.branch ?? ref)
          return result
        }),
        createWorktree: Effect.fn("command.createWorktree")(function* (repo: RepoId, base: RefId, newBranch: string, path: string) {
          const worktree = yield* rpc.createWorktree(repo, base, newBranch, path)
          yield* rpc.setActiveWorktree(repo, worktree.id)
          if (worktree.head.refId) {
            yield* rpc.setEmphasizedRef(repo, worktree.head.refId)
          }
          return worktree
        }),
        removeWorktree: Effect.fn("command.removeWorktree")(function* (worktree: WorktreeId, force: boolean) {
          yield* rpc.removeWorktree(worktree, force)
        }),
        chooseWorktreeParent: Effect.fn("command.chooseWorktreeParent")(function* () {
          return yield* rpc.chooseWorktreeParent()
        }),
        fetch: Effect.fn("command.fetch")(function* (repo: RepoId, remote: string) {
          yield* rpc.fetch(repo, remote)
        }),
        pull: Effect.fn("command.pull")(function* (worktree: WorktreeId) {
          yield* rpc.pull(worktree)
        }),
        push: Effect.fn("command.push")(function* (worktree: WorktreeId, remote: string, force: boolean) {
          yield* rpc.push(worktree, remote, force)
        }),
        cancelOperation: Effect.fn("command.cancelOperation")(function* (repo: RepoId, operation: string) {
          yield* rpc.cancelOperation(repo, operation)
        }),
      })
    }),
  )
}
