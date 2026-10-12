import { useLiveQuery } from "@tanstack/react-db"
import { Cause, type Effect, Exit, type ManagedRuntime } from "effect"
import { useCallback } from "react"
import { preferencesCollection, sessionCollection } from "@/data/collections"
import type { Preferences, Session } from "@/model/model.gen"
import { appRuntime } from "@/services/runtime"
import { notify } from "./notifications"

type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof appRuntime>

/**
 * Returns a function that runs an effect on the app runtime. Failures it
 * does not handle are shown to the user rather than thrown.
 */
export const useRun = () =>
  useCallback(<A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A | undefined> =>
    appRuntime.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) {
        return exit.value
      }
      if (!Cause.hasInterruptsOnly(exit.cause)) {
        const error = Cause.squash(exit.cause)
        notify({ message: error instanceof Error ? error.message : String(error), tone: "error" })
      }
      return undefined
    }), [])

/** The current preferences, or undefined until the first snapshot arrives. */
export const usePreferences = (): Preferences | undefined =>
  useLiveQuery({ query: (q) => q.from({ preferences: preferencesCollection }) }).data[0]

/** The current session, or undefined until the first snapshot arrives. */
export const useSession = (): Session | undefined =>
  useLiveQuery({ query: (q) => q.from({ session: sessionCollection }) }).data[0]
