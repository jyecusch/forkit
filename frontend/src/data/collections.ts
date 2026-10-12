import { createCollection, type Collection, type UpdateMutationFn } from "@tanstack/db"
import { Effect, Fiber, type Schema } from "effect"
import {
  FileStatus,
  GraphView,
  Operation,
  Preferences,
  Ref,
  Remote,
  Repo,
  Session,
  Worktree,
  type RepoId,
  type WorktreeId,
} from "@/model/model.gen"
import { coreRuntime } from "@/services/core"
import { Rpc } from "@/services/Rpc"
import { SyncClient } from "@/services/SyncClient"

/** How long a collection nothing reads keeps syncing before it is dropped. */
const gcTime = 30_000

interface SyncedCollectionOptions<A extends object> {
  readonly getKey: (entity: A) => string
  readonly onUpdate?: UpdateMutationFn<A, string>
}

/**
 * Defines a collection that mirrors one backend sync channel. Each scope
 * (usually a repository or worktree ID) gets its own collection, created on
 * first use, which follows the backend for as long as something reads it.
 */
const syncedCollection = <S extends Schema.Codec<object, unknown>>(
  channel: string,
  schema: S,
  options: SyncedCollectionOptions<S["Type"]>,
) => {
  type A = S["Type"]
  const byScope = new Map<string, Collection<A, string>>()
  return (scope: string): Collection<A, string> => {
    const existing = byScope.get(scope)
    if (existing) {
      return existing
    }
    const collection = createCollection<A, string>({
      id: `${channel}:${scope}`,
      getKey: options.getKey,
      gcTime,
      ...(options.onUpdate && { onUpdate: options.onUpdate }),
      sync: {
        sync: ({ begin, write, commit, markReady, truncate }) => {
          const fiber = coreRuntime.runFork(
            SyncClient.use((client) =>
              client.follow(channel, scope, schema, {
                reset: (entities) => {
                  begin()
                  truncate()
                  for (const value of entities) write({ type: "insert", value })
                  commit()
                  markReady()
                },
                apply: (ops) => {
                  begin()
                  for (const op of ops) {
                    write(op.type === "delete" ? { type: "delete", key: op.key } : { type: op.type, value: op.value })
                  }
                  commit()
                },
              }),
            ).pipe(Effect.tapCause((cause) => Effect.logError(`sync of ${channel}:${scope} stopped`, cause))),
          )
          return () => {
            coreRuntime.runFork(Fiber.interrupt(fiber))
          }
        },
      },
    })
    byScope.set(scope, collection)
    return collection
  }
}

const byId = <A extends { readonly id: string }>(entity: A) => entity.id

/** Scope of the single-row preferences and session collections. */
export const userScope = "user"

export const reposCollection = syncedCollection("repos", Repo, { getKey: byId })("all")
export const sessionCollection = syncedCollection("session", Session, { getKey: byId })(userScope)

/** Collections scoped by repository ID. */
export const worktreesCollection: (repo: RepoId) => Collection<Worktree, string> = syncedCollection("worktrees", Worktree, { getKey: byId })
export const refsCollection: (repo: RepoId) => Collection<Ref, string> = syncedCollection("refs", Ref, { getKey: byId })
export const remotesCollection: (repo: RepoId) => Collection<Remote, string> = syncedCollection("remotes", Remote, { getKey: byId })
export const graphViewsCollection: (repo: RepoId) => Collection<GraphView, string> = syncedCollection("graphViews", GraphView, { getKey: byId })
export const operationsCollection: (repo: RepoId) => Collection<Operation, string> = syncedCollection("operations", Operation, { getKey: byId })

/** File statuses are scoped by worktree ID. */
export const fileStatusesCollection: (worktree: WorktreeId) => Collection<FileStatus, string> = syncedCollection("fileStatuses", FileStatus, { getKey: byId })

/** Metadata attached to an optimistic preference change. */
export interface PreferenceChange {
  readonly path: string
  readonly value: unknown
}

/**
 * Preferences change optimistically; the backend validates and saves each
 * change, and the delta that follows confirms it.
 */
export const preferencesCollection = syncedCollection("preferences", Preferences, {
  getKey: byId,
  onUpdate: async ({ transaction }) => {
    for (const mutation of transaction.mutations) {
      const change = mutation.metadata as unknown as PreferenceChange
      await coreRuntime.runPromise(Rpc.use((rpc) => rpc.setPreference(change.path, change.value)))
    }
  },
})(userScope)
