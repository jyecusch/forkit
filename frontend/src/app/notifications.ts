import { useSyncExternalStore } from "react"

/** A transient message, optionally with one action the user can take. */
export interface Notice {
  readonly id: number
  readonly message: string
  readonly tone: "info" | "error"
  /** Milliseconds shown before it goes by itself; notices with an action stay. */
  readonly duration?: number
  readonly action?: { readonly label: string; readonly run: () => void }
}

let current: Notice | undefined
let nextId = 0
const listeners = new Set<() => void>()

const publish = (notice: Notice | undefined) => {
  current = notice
  for (const listener of listeners) listener()
}

export const notify = (notice: Omit<Notice, "id">) => publish({ ...notice, id: ++nextId })

/** Drops a notice offering an action, which belongs to the view it came from. */
export const dismissActions = () => {
  if (current?.action) publish(undefined)
}

export const dismiss = (id: number) => {
  if (current?.id === id) publish(undefined)
}

export const useNotice = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
