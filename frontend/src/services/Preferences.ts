import { Context, Effect, Layer, Schema } from "effect"
import { preferencesCollection, userScope, type PreferenceChange } from "@/data/collections"
import type { RpcFailure } from "@/model/errors"
import { Preferences as PreferencesSchema } from "@/model/model.gen"
import { fromRejection } from "@/model/errors"
import { Rpc } from "./Rpc"

/** A preference value the schema does not allow. */
export class InvalidPreference extends Schema.TaggedError<InvalidPreference>()("InvalidPreference", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Typed changes to user preferences. */
export class Preferences extends Context.Service<
  Preferences,
  {
    /** Changes the value at a dot-separated path such as "graph.showTags". */
    readonly set: (path: string, value: unknown) => Effect.Effect<void, InvalidPreference | RpcFailure>
    /** Restores the default value at path. */
    readonly reset: (path: string) => Effect.Effect<void, RpcFailure>
  }
>()("forkit/Preferences") {
  static readonly layer = Layer.effect(
    Preferences,
    Effect.gen(function* () {
      const rpc = yield* Rpc
      const validate = Schema.decodeUnknownEffect(PreferencesSchema)

      const set = Effect.fn("Preferences.set")(function* (path: string, value: unknown) {
        const current = preferencesCollection.get(userScope)
        if (current) {
          yield* validate(withPath(current, path, value)).pipe(
            Effect.mapError((issue) => new InvalidPreference({ path, message: issue.message })),
          )
        }
        const change: PreferenceChange = { path, value }
        const transaction = preferencesCollection.update(userScope, { metadata: { ...change } }, (draft) => {
          assignPath(draft, path, value)
        })
        yield* Effect.tryPromise({ try: () => transaction.isPersisted.promise, catch: fromRejection })
      })

      const reset = Effect.fn("Preferences.reset")(function* (path: string) {
        yield* rpc.resetPreference(path)
      })

      return Preferences.of({ set, reset })
    }),
  )
}

const withPath = (source: object, path: string, value: unknown): unknown => {
  const copy = structuredClone(source)
  assignPath(copy, path, value)
  return copy
}

const assignPath = (target: object, path: string, value: unknown) => {
  const keys = path.split(".")
  let node = target as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    node = node[key] as Record<string, unknown>
  }
  node[keys[keys.length - 1]!] = value
}
