import { Context, Layer } from "effect"
import { EventsOn } from "@/wailsjs/runtime/runtime"

/** Events pushed by the backend. */
export class BackendEvents extends Context.Service<
  BackendEvents,
  {
    /** Calls listener for each event named name until the returned function is called. */
    readonly on: (name: string, listener: (payload: unknown) => void) => () => void
  }
>()("forkit/BackendEvents") {
  static readonly layer = Layer.succeed(BackendEvents, {
    on: (name, listener) => EventsOn(name, listener),
  })
}
