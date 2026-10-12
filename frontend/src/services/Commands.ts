import { Context, Effect, Layer, type Option } from "effect"
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
    readonly selectWorktree: (repo: RepoId, worktree: WorktreeId) => Effect.Effect<void, RpcFailure>
    /**
     * Makes ref the emphasized history and returns the graph row of its
     * tip, or -1 when that commit is not shown.
     */
    readonly emphasize: (repo: RepoId, ref: RefId) => Effect.Effect<number, RpcFailure>
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
  }
>()("forkit/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const rpc = yield* Rpc
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
        selectWorktree: Effect.fn("command.selectWorktree")(function* (repo: RepoId, worktree: WorktreeId) {
          yield* rpc.setActiveWorktree(repo, worktree)
        }),
        emphasize: Effect.fn("command.emphasize")(function* (repo: RepoId, ref: RefId) {
          const [row] = yield* Effect.all([rpc.rowOfRef(repo, ref), rpc.setEmphasizedRef(repo, ref)], {
            concurrency: "unbounded",
          })
          return row
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
      })
    }),
  )
}
