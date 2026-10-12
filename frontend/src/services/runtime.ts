import { Layer, ManagedRuntime } from "effect"
import { Commands } from "./Commands"
import { CoreLayer, memoMap } from "./core"
import { GraphData } from "./GraphData"
import { Preferences } from "./Preferences"

/** Every service the UI uses. */
export const AppLayer = Layer.mergeAll(Commands.layer, GraphData.layer, Preferences.layer).pipe(
  Layer.provideMerge(CoreLayer),
)

/** The one runtime React runs effects on. */
export const appRuntime = ManagedRuntime.make(AppLayer, { memoMap })

/** The services effects run on the app runtime may use. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof appRuntime>
