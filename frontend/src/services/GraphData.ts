import { Context, Effect, Layer } from "effect"
import type { RpcFailure } from "@/model/errors"
import type { Commit, GraphRow, GraphView, RefId, RepoId } from "@/model/model.gen"
import { Rpc } from "./Rpc"

/** Rows are fetched in aligned blocks of this many. */
export const blockSize = 500
/** Blocks kept per repository; enough for several screens either side. */
const maxBlocks = 40

/** A row ready to draw: its layout and its commit. */
export interface LoadedRow {
  readonly row: GraphRow
  readonly commit: Commit
}

interface Block {
  readonly version: number
  readonly rows: ReadonlyArray<LoadedRow>
}

/** What decides a block's content besides its position. */
interface ViewKey {
  readonly version: number
  readonly emphasized: RefId | undefined
}

class RepoCache {
  key: ViewKey = { version: -1, emphasized: undefined }
  readonly blocks = new Map<number, Block>()
  /** Invalidated blocks, still drawn until their replacements arrive. */
  readonly stale = new Map<number, Block>()
  /** Blocks being fetched, with the view each fetch is for. */
  readonly pending = new Map<number, ViewKey>()
  /** Increases whenever rows arrive. */
  revision = 0
  readonly listeners = new Set<() => void>()

  /**
   * Moves to a new graph version, keeping blocks the backend says did not
   * change. Changes in emphasis invalidate everything.
   */
  advance(view: GraphView, emphasized: RefId | undefined) {
    if (this.key.version === view.version && this.key.emphasized === emphasized) {
      return
    }
    const unchangedBefore =
      emphasized === this.key.emphasized && view.version === this.key.version + 1 ? view.firstChangedRow : 0
    for (const [index, block] of this.blocks) {
      if ((index + 1) * blockSize > unchangedBefore) {
        this.blocks.delete(index)
        this.stale.set(index, block)
      } else {
        this.blocks.set(index, { ...block, version: view.version })
      }
    }
    for (const index of this.stale.keys()) {
      if (index * blockSize >= view.totalRows) this.stale.delete(index)
    }
    trimOldest(this.stale)
    this.pending.clear()
    this.key = { version: view.version, emphasized }
  }

  store(index: number, block: Block) {
    this.stale.delete(index)
    this.blocks.delete(index)
    this.blocks.set(index, block)
    trimOldest(this.blocks)
    this.revision++
    for (const listener of this.listeners) listener()
  }
}

/** Drops the least recently stored blocks beyond maxBlocks. */
const trimOldest = (blocks: Map<number, Block>) => {
  while (blocks.size > maxBlocks) {
    blocks.delete(blocks.keys().next().value!)
  }
}

/** The rows a view needs, as GraphData.ensure takes them. */
export interface RowRequest {
  readonly repo: RepoId
  readonly view: GraphView
  readonly emphasized: RefId | undefined
  /** Visible rows, inclusive; blocks either side are fetched too. */
  readonly first: number
  readonly last: number
}

/** Windowed, cached access to a repository's graph rows. */
export class GraphData extends Context.Service<
  GraphData,
  {
    /**
     * Fetches whatever blocks around rows [first, last] are missing for the
     * given view and emphasis.
     */
    readonly ensure: (request: RowRequest) => Effect.Effect<void, RpcFailure>
    /** Returns a loaded row, or undefined while it is still being fetched. */
    readonly peek: (repo: RepoId, index: number) => LoadedRow | undefined
    /** Calls listener whenever new rows arrive for repo. */
    readonly subscribe: (repo: RepoId, listener: () => void) => () => void
    /** A number that changes whenever new rows arrive for repo. */
    readonly revision: (repo: RepoId) => number
    /** Drops cached rows of repositories not in open. */
    readonly retain: (open: ReadonlyArray<RepoId>) => void
  }
>()("forkit/GraphData") {
  static readonly layer = Layer.effect(
    GraphData,
    Effect.gen(function* () {
      const rpc = yield* Rpc
      const caches = new Map<RepoId, RepoCache>()
      const cacheFor = (repo: RepoId) => {
        let cache = caches.get(repo)
        if (!cache) {
          cache = new RepoCache()
          caches.set(repo, cache)
        }
        return cache
      }

      const fetchBlock = (repo: RepoId, cache: RepoCache, index: number) => {
        const key = cache.key
        cache.pending.set(index, key)
        const settle = () => {
          if (cache.pending.get(index) === key) cache.pending.delete(index)
        }
        return rpc.graphWindow(repo, index * blockSize, blockSize, key.emphasized).pipe(
          Effect.map((window) => {
            settle()
            if (cache.key !== key) {
              return
            }
            const rows = window.rows.map((row, i) => ({ row, commit: window.commits[i]! }))
            cache.store(index, { version: key.version, rows })
          }),
          Effect.onExit(() => Effect.sync(settle)),
        )
      }

      const ensure = Effect.fn("GraphData.ensure")(function* ({ repo, view, emphasized, first, last }: RowRequest) {
        const cache = cacheFor(repo)
        cache.advance(view, emphasized)
        const lastRow = Math.min(last + blockSize, view.totalRows - 1)
        const missing: Array<number> = []
        for (let index = Math.max(0, Math.floor((first - blockSize) / blockSize)); index * blockSize <= lastRow; index++) {
          if (!cache.blocks.has(index) && !cache.pending.has(index)) {
            missing.push(index)
          }
        }
        yield* Effect.annotateCurrentSpan({ "graph.blocks": missing.length })
        yield* Effect.forEach(missing, (index) => fetchBlock(repo, cache, index), { concurrency: 2, discard: true })
      })

      const peek = (repo: RepoId, index: number) => {
        const cache = caches.get(repo)
        const blockIndex = Math.floor(index / blockSize)
        const block = cache?.blocks.get(blockIndex) ?? cache?.stale.get(blockIndex)
        return block?.rows[index % blockSize]
      }

      const subscribe = (repo: RepoId, listener: () => void) => {
        const cache = cacheFor(repo)
        cache.listeners.add(listener)
        return () => cache.listeners.delete(listener)
      }

      const revision = (repo: RepoId) => caches.get(repo)?.revision ?? 0

      const retain = (open: ReadonlyArray<RepoId>) => {
        for (const repo of caches.keys()) {
          if (!open.includes(repo)) caches.delete(repo)
        }
      }

      return GraphData.of({ ensure, peek, subscribe, revision, retain })
    }),
  )
}
