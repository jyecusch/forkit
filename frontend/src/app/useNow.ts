import { useSyncExternalStore } from "react"

let now = Date.now()
const listeners = new Set<() => void>()
setInterval(() => {
  now = Date.now()
  for (const listener of listeners) listener()
}, 60_000)

/** The current time, updated each minute, so relative dates stay true. */
export const useNow = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => now,
  )
