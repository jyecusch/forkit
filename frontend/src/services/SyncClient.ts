import { Context, Effect, Layer, Queue, Schema, Tracer } from "effect"
import type { RpcFailure } from "@/model/errors"
import { SyncDelta, type SyncOpType } from "@/model/model.gen"
import { BackendEvents } from "./BackendEvents"
import { Rpc } from "./Rpc"

/** A delta operation with its entity decoded. */
export type DecodedOp<A> =
  | { readonly type: Exclude<SyncOpType, "delete">; readonly key: string; readonly value: A }
  | { readonly type: "delete"; readonly key: string }

/** Where a followed channel scope's state is applied. */
export interface SyncTarget<A> {
  /** Replaces everything with a fresh snapshot. */
  readonly reset: (entities: ReadonlyArray<A>) => void
  /** Applies one delta's operations together. */
  readonly apply: (ops: ReadonlyArray<DecodedOp<A>>) => void
}

/** Mirrors backend channel scopes by taking a snapshot and applying deltas. */
export class SyncClient extends Context.Service<
  SyncClient,
  {
    /**
     * Keeps target in step with a channel scope until interrupted. A gap in
     * the delta sequence triggers a fresh snapshot.
     */
    readonly follow: <S extends Schema.Codec<object, unknown>>(
      channel: string,
      scope: string,
      schema: S,
      target: SyncTarget<S["Type"]>,
    ) => Effect.Effect<never, RpcFailure>
  }
>()("forkit/SyncClient") {
  static readonly layer = Layer.effect(
    SyncClient,
    Effect.gen(function* () {
      const rpc = yield* Rpc
      const events = yield* BackendEvents

      const follow = <S extends Schema.Codec<object, unknown>>(
        channel: string,
        scope: string,
        schema: S,
        target: SyncTarget<S["Type"]>,
      ): Effect.Effect<never, RpcFailure> =>
        Effect.gen(function* () {
          const decodeEntity = Schema.decodeUnknownSync(schema)
          const decodeDelta = Schema.decodeUnknownSync(SyncDelta)
          const deltas = yield* Queue.unbounded<unknown>()
          // Listen before taking the snapshot so no delta falls in between.
          yield* Effect.acquireRelease(
            Effect.sync(() => events.on(`sync:${channel}:${scope}`, (delta) => Queue.offerUnsafe(deltas, delta))),
            (stopListening) => Effect.sync(stopListening),
          )

          const snapshot = Effect.gen(function* () {
            const { seq, entities } = yield* rpc.subscribe(channel, scope)
            target.reset(entities.map((entity) => decodeEntity(entity)))
            return seq
          }).pipe(Effect.withSpan("sync.snapshot", { attributes: { "sync.channel": channel, "sync.scope": scope } }))

          let lastSeq = yield* snapshot
          while (true) {
            const delta = decodeDelta(yield* Queue.take(deltas))
            if (delta.seq <= lastSeq) {
              continue
            }
            if (delta.prevSeq !== lastSeq) {
              lastSeq = yield* snapshot
              continue
            }
            yield* Effect.sync(() =>
              target.apply(
                delta.ops.map((op): DecodedOp<S["Type"]> =>
                  op.type === "delete" ? { type: "delete", key: op.key } : { type: op.type, key: op.key, value: decodeEntity(op.value) },
                ),
              ),
            ).pipe(
              Effect.withSpan("sync.apply", {
                attributes: { "sync.channel": channel, "sync.scope": scope, "sync.ops": delta.ops.length },
                links: linkTo(delta.traceparent),
              }),
            )
            lastSeq = delta.seq
          }
        }).pipe(Effect.scoped)

      return SyncClient.of({ follow })
    }),
  )
}

/** Links the span applying a delta to the backend span that produced it. */
const linkTo = (traceparent: string): Array<Tracer.SpanLink> => {
  const [, traceId, spanId, flags] = traceparent.split("-")
  if (!traceId || !spanId) {
    return []
  }
  return [{ span: Tracer.externalSpan({ traceId, spanId, sampled: flags === "01" }), attributes: {} }]
}
