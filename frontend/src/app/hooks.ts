import { useLiveQuery } from "@tanstack/react-db"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { useCallback, useEffect, type DependencyList } from "react"
import { preferencesCollection, sessionCollection } from "@/data/collections"
import type { Preferences, Session } from "@/model/model.gen"
import { appRuntime, type AppServices } from "@/services/runtime"
import { notify } from "./notifications"

const reportFailure = (cause: Cause.Cause<unknown>) => {
  if (!Cause.hasInterruptsOnly(cause)) {
    const error = Cause.squash(cause)
    notify({ message: error instanceof Error ? error.message : String(error), tone: "error" })
  }
}

/**
 * Returns a function that runs an effect on the app runtime. It resolves to
 * Some with the result, or None after showing an unhandled failure to the
 * user.
 */
export const useRun = () =>
  useCallback(
    <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<Option.Option<A>> =>
      appRuntime.runPromiseExit(effect).then((exit) => {
        if (Exit.isSuccess(exit)) {
          return Option.some(exit.value)
        }
        reportFailure(exit.cause)
        return Option.none()
      }),
    [],
  )

/**
 * Runs an effect while a component is mounted, interrupting it when deps
 * change or the component unmounts. Unhandled failures are shown to the user.
 */
export const useForkedEffect = (make: () => Effect.Effect<unknown, unknown, AppServices>, deps: DependencyList) =>
  useEffect(() => {
    const fiber = appRuntime.runFork(make().pipe(Effect.catchCause((cause) => Effect.sync(() => reportFailure(cause)))))
    return () => {
      appRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, deps)

/** The current preferences, or undefined until the first snapshot arrives. */
export const usePreferences = (): Preferences | undefined =>
  useLiveQuery({ query: (q) => q.from({ preferences: preferencesCollection }) }).data[0]

/** The current session, or undefined until the first snapshot arrives. */
export const useSession = (): Session | undefined =>
  useLiveQuery({ query: (q) => q.from({ session: sessionCollection }) }).data[0]
