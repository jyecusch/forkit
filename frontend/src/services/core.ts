import { Layer, ManagedRuntime } from "effect"
import { BackendEvents } from "./BackendEvents"
import { Rpc } from "./Rpc"
import { SyncClient } from "./SyncClient"
import { TelemetryLayer } from "./Telemetry"

/**
 * Shared by every runtime so each layer is built once, however many
 * runtimes use it.
 */
export const memoMap = Layer.makeMemoMapUnsafe()

/** Backend access, sync and telemetry: what synced collections need. */
export const CoreLayer = Layer.mergeAll(Rpc.layer, BackendEvents.layer, TelemetryLayer).pipe(
  Layer.provideMerge(SyncClient.layer.pipe(Layer.provide(Rpc.layer), Layer.provide(BackendEvents.layer))),
)

export const coreRuntime = ManagedRuntime.make(CoreLayer, { memoMap })
