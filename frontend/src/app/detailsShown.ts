import { useSyncExternalStore } from "react"

const key = "forkit.detailsShown"

const read = (): boolean | undefined => {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? undefined : stored === "true"
  } catch {
    return undefined
  }
}

/** Whether the user chose to show the details panel; undefined follows the window's width. */
let chosen = read()
const listeners = new Set<() => void>()
const wide = typeof matchMedia === "function" ? matchMedia("(min-width: 1000px)") : undefined

const shown = () => chosen ?? wide?.matches ?? true

/** Shows or hides the details panel in every repository, remembered across launches. */
export const toggleDetails = () => {
  chosen = !shown()
  try {
    localStorage.setItem(key, String(chosen))
  } catch {
    // Not remembered, but still applied.
  }
  for (const listener of listeners) listener()
}

export const useDetailsShown = (): boolean =>
  useSyncExternalStore((listener) => {
    listeners.add(listener)
    wide?.addEventListener("change", listener)
    return () => {
      listeners.delete(listener)
      wide?.removeEventListener("change", listener)
    }
  }, shown)
