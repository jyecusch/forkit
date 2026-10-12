import { useSyncExternalStore } from "react"

let open = false
const listeners = new Set<() => void>()

/** Opens or closes the one preferences dialog, from anywhere. */
export const setPreferencesOpen = (next: boolean) => {
  open = next
  for (const listener of listeners) listener()
}

export const usePreferencesOpen = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
