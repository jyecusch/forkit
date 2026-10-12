import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema } from "effect"
import type { SyncSnapshot } from "@/model/model.gen"
import { BackendEvents } from "./BackendEvents"
import { Rpc } from "./Rpc"
import { SyncClient, type DecodedOp } from "./SyncClient"

const Item = Schema.Struct({ id: Schema.String, n: Schema.Number })
type Item = typeof Item.Type

/** A fake backend whose snapshot and events the test controls. */
const fakeBackend = () => {
  const listeners = new Map<string, (payload: unknown) => void>()
  let snapshot: SyncSnapshot = { seq: 0, entities: [] }
  let subscriptions = 0
  const layer = SyncClient.layer.pipe(
    Layer.provide(
      Layer.succeed(BackendEvents, {
        on: (name, listener) => {
          listeners.set(name, listener)
          return () => listeners.delete(name)
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(Rpc, {
        subscribe: () =>
          Effect.sync(() => {
            subscriptions++
            return snapshot
          }),
      } as unknown as Rpc["Service"]),
    ),
  )
  return {
    layer,
    setSnapshot: (next: SyncSnapshot) => (snapshot = next),
    emit: (payload: unknown) => listeners.get("sync:items:s")?.(payload),
    subscriptions: () => subscriptions,
  }
}

const recorder = () => {
  const state = new Map<string, Item>()
  return {
    state,
    target: {
      reset: (entities: ReadonlyArray<Item>) => {
        state.clear()
        for (const e of entities) state.set(e.id, e)
      },
      apply: (ops: ReadonlyArray<DecodedOp<Item>>) => {
        for (const op of ops) {
          if (op.type === "delete") state.delete(op.key)
          else state.set(op.key, op.value)
        }
      },
    },
  }
}

describe("SyncClient", () => {
  it.effect("applies deltas that follow the snapshot and resyncs on a gap", () => {
    const backend = fakeBackend()
    const { state, target } = recorder()
    backend.setSnapshot({ seq: 1, entities: [{ id: "a", n: 1 }] })
    return Effect.gen(function* () {
      const client = yield* SyncClient
      const fiber = yield* Effect.forkChild(client.follow("items", "s", Item, target))
      yield* Effect.yieldNow

      backend.emit({ seq: 1, prevSeq: 0, traceparent: "", ops: [{ type: "insert", key: "stale", value: { id: "stale", n: 0 } }] })
      backend.emit({ seq: 2, prevSeq: 1, traceparent: "", ops: [{ type: "update", key: "a", value: { id: "a", n: 2 } }] })
      yield* Effect.yieldNow
      expect([...state.values()]).toEqual([{ id: "a", n: 2 }])

      backend.setSnapshot({ seq: 9, entities: [{ id: "b", n: 9 }] })
      backend.emit({ seq: 5, prevSeq: 4, traceparent: "", ops: [] })
      yield* Effect.yieldNow
      expect([...state.values()]).toEqual([{ id: "b", n: 9 }])
      expect(backend.subscriptions()).toBe(2)

      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(backend.layer))
  })
})
