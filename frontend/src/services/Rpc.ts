import { Context, Effect, Layer, Option, Schema, type Tracer } from "effect"
import { fromRejection, type RpcFailure } from "@/model/errors"
import {
  CommitDetail,
  GraphWindow,
  Repo,
  SyncSnapshot,
  type Oid,
  type RefId,
  type RepoId,
  type WorktreeId,
} from "@/model/model.gen"
import { model } from "@/wailsjs/go/models"
import * as Preferences from "@/wailsjs/go/rpc/Preferences"
import * as Repos from "@/wailsjs/go/rpc/Repos"
import * as Session from "@/wailsjs/go/rpc/Session"
import * as Sync from "@/wailsjs/go/rpc/Sync"

/** Typed, traced access to the backend's bound services. */
export class Rpc extends Context.Service<
  Rpc,
  {
    readonly subscribe: (channel: string, scope: string) => Effect.Effect<SyncSnapshot, RpcFailure>
    readonly openRepo: (path: string) => Effect.Effect<Repo, RpcFailure>
    /** Resolves to None when the user cancels the folder picker. */
    readonly chooseAndOpenRepo: () => Effect.Effect<Option.Option<Repo>, RpcFailure>
    readonly closeRepo: (id: RepoId) => Effect.Effect<void, RpcFailure>
    readonly graphWindow: (
      id: RepoId,
      start: number,
      count: number,
      emphasized: RefId | undefined,
    ) => Effect.Effect<GraphWindow, RpcFailure>
    readonly rowOfRef: (id: RepoId, ref: RefId) => Effect.Effect<number, RpcFailure>
    readonly commitDetail: (id: RepoId, oid: Oid) => Effect.Effect<CommitDetail, RpcFailure>
    readonly setPreference: (path: string, value: unknown) => Effect.Effect<void, RpcFailure>
    readonly resetPreference: (path: string) => Effect.Effect<void, RpcFailure>
    readonly setActiveRepo: (id: RepoId) => Effect.Effect<void, RpcFailure>
    readonly reorderRepos: (ids: ReadonlyArray<RepoId>) => Effect.Effect<void, RpcFailure>
    readonly setActiveWorktree: (repo: RepoId, worktree: WorktreeId) => Effect.Effect<void, RpcFailure>
    readonly setEmphasizedRef: (repo: RepoId, ref: RefId) => Effect.Effect<void, RpcFailure>
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
      invoke("Repos.ChooseAndOpen", Repo, (meta) => Repos.ChooseAndOpen(meta)).pipe(
        Effect.map((repo) => (repo.id === "" ? Option.none() : Option.some(repo))),
      ),
    closeRepo: (id) => invoke("Repos.Close", Schema.Void, (meta) => Repos.Close(meta, id), { "repo.id": id }),
    graphWindow: (id, start, count, emphasized) =>
      invoke("Repos.GraphWindow", GraphWindow, (meta) => Repos.GraphWindow(meta, id, start, count, emphasized ?? ""), {
        "repo.id": id,
        "rows.start": start,
        "rows.requested": count,
      }),
    rowOfRef: (id, ref) => invoke("Repos.RowOfRef", Schema.Int, (meta) => Repos.RowOfRef(meta, id, ref), { "repo.id": id }),
    commitDetail: (id, oid) =>
      invoke("Repos.CommitDetail", CommitDetail, (meta) => Repos.CommitDetail(meta, id, oid), { "repo.id": id }),
    setPreference: (path, value) =>
      invoke("Preferences.Set", Schema.Void, (meta) => Preferences.Set(meta, path, value), { "preference.path": path }),
    resetPreference: (path) =>
      invoke("Preferences.Reset", Schema.Void, (meta) => Preferences.Reset(meta, path), { "preference.path": path }),
    setActiveRepo: (id) => invoke("Session.SetActiveRepo", Schema.Void, (meta) => Session.SetActiveRepo(meta, id)),
    reorderRepos: (ids) =>
      invoke("Session.ReorderRepos", Schema.Void, (meta) => Session.ReorderRepos(meta, [...ids])),
    setActiveWorktree: (repo, worktree) =>
      invoke("Session.SetActiveWorktree", Schema.Void, (meta) => Session.SetActiveWorktree(meta, repo, worktree)),
    setEmphasizedRef: (repo, ref) =>
      invoke("Session.SetEmphasizedRef", Schema.Void, (meta) => Session.SetEmphasizedRef(meta, repo, ref)),
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
