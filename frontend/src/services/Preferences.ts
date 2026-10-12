import { Context, Effect, Layer, Schema } from "effect"
import { preferencesCollection, userScope } from "@/data/collections"
import { fromRejection, type RpcFailure } from "@/model/errors"
import { Preferences as PreferencesSchema } from "@/model/model.gen"
import { Rpc } from "./Rpc"

type Groups = Omit<PreferencesSchema, "id" | "version">

/** A dot-separated path to one preference, such as "graph.showTags". */
export type PreferencePath = {
  [G in keyof Groups & string]: `${G}.${keyof Groups[G] & string}`
}[keyof Groups & string]

/** The type of the preference at P. */
export type PreferenceValue<P extends PreferencePath> = P extends `${infer G extends keyof Groups}.${infer K}`
  ? K extends keyof Groups[G]
    ? Groups[G][K]
    : never
  : never

/** A preference value the schema does not allow. */
export class InvalidPreference extends Schema.TaggedError<InvalidPreference>()("InvalidPreference", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Typed changes to user preferences. */
export class Preferences extends Context.Service<
  Preferences,
  {
    /**
     * Changes one preference. The change shows immediately and is undone if
     * the backend rejects it.
     */
    readonly set: <P extends PreferencePath>(path: P, value: PreferenceValue<P>) => Effect.Effect<void, InvalidPreference | RpcFailure>
    /**
     * Restores a preference's default. Only the backend knows the defaults,
     * so this waits for it instead of changing anything optimistically.
     */
    readonly reset: (path: PreferencePath) => Effect.Effect<void, RpcFailure>
  }
>()("forkit/Preferences") {
  static readonly layer = Layer.effect(
    Preferences,
    Effect.gen(function* () {
      const rpc = yield* Rpc
      const validate = Schema.decodeUnknownEffect(PreferencesSchema)

      const set = Effect.fn("Preferences.set")(function* <P extends PreferencePath>(path: P, value: PreferenceValue<P>) {
        const current = preferencesCollection.get(userScope)
        if (!current) {
          return yield* new InvalidPreference({ path, message: "Preferences have not loaded yet." })
        }
        yield* validate(withPath(current, path, value)).pipe(
          Effect.mapError((issue) => new InvalidPreference({ path, message: issue.message })),
        )
        const transaction = preferencesCollection.update(userScope, { metadata: { path, value } }, (draft) => {
          assignPath(draft, path, value)
        })
        yield* Effect.tryPromise({ try: () => transaction.isPersisted.promise, catch: fromRejection })
      })

      const reset = Effect.fn("Preferences.reset")(function* (path: PreferencePath) {
        yield* rpc.resetPreference(path)
      })

      return Preferences.of({ set, reset })
    }),
  )
}

const withPath = (source: object, path: PreferencePath, value: unknown): unknown => {
  const copy = structuredClone(source)
  assignPath(copy, path, value)
  return copy
}

const assignPath = (target: object, path: PreferencePath, value: unknown) => {
  const [group, key] = path.split(".") as [string, string]
  ;((target as Record<string, Record<string, unknown>>)[group]!)[key] = value
}
