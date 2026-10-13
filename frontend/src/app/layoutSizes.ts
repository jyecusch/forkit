import { useEffect, useState } from "react"
import type { LayoutSize } from "@/model/model.gen"
import { Rpc } from "@/services/Rpc"
import { useRun, useSession } from "./hooks"

export interface LayoutSizeControl {
  /** The size being dragged to, or the one remembered; undefined when it is chosen automatically. */
  readonly size: number | undefined
  /** Follows a drag without remembering it yet. */
  readonly resize: (size: number) => void
  /** Remembers the size a drag or key press ended on. */
  readonly commit: (size: number) => void
  /** Forgets the size, so it is chosen automatically again. */
  readonly reset: () => void
}

/** A panel or column's size, remembered in the session across restarts. */
export const useLayoutSize = (name: LayoutSize): LayoutSizeControl => {
  const run = useRun()
  const saved = useSession()?.layout?.[name]
  const [pending, setPending] = useState<number>()
  // A committed size stays shown until the session confirms it, so the panel
  // does not jump back for the moment in between.
  useEffect(() => {
    if (pending !== undefined && pending === saved) setPending(undefined)
  }, [pending, saved])
  return {
    size: pending ?? saved,
    resize: setPending,
    commit: (size) => {
      setPending(size)
      void run(Rpc.use((rpc) => rpc.setLayoutSize(name, size)))
    },
    reset: () => {
      setPending(undefined)
      void run(Rpc.use((rpc) => rpc.resetLayoutSize(name)))
    },
  }
}
