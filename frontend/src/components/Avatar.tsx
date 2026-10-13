import { Effect } from "effect"
import { createHashvatar } from "hashvatar"
import { useEffect, useState } from "react"
import { usePreferences } from "@/app/hooks"
import { appRuntime } from "@/services/runtime"
import { Rpc } from "@/services/Rpc"
import { cn } from "@/lib/utils"

interface AvatarProps {
  readonly name: string
  readonly email: string
  /** Width and height in CSS pixels. */
  readonly size: number
  readonly className?: string
}

/**
 * A commit author's picture: their Gravatar when they have one and Gravatar
 * is turned on, otherwise a dithered pattern made from their email, which is
 * drawn at once and replaced if a Gravatar arrives.
 */
export const Avatar = ({ name, email, size, className }: AvatarProps) => {
  const address = email.trim().toLowerCase()
  const key = address || name
  const useGravatar = (usePreferences()?.appearance.gravatars ?? false) && address !== ""
  const [gravatar, setGravatar] = useState<string>()
  useEffect(() => {
    setGravatar(undefined)
    if (!useGravatar) return
    let current = true
    void gravatarOf(key).then((picture) => current && setGravatar(picture || undefined))
    return () => {
      current = false
    }
  }, [key, useGravatar])

  return (
    <span
      aria-hidden
      className={cn("relative inline-block flex-none overflow-hidden rounded-full bg-cover", className)}
      style={{ width: size, height: size, backgroundImage: `url(${gravatar ?? pattern(key, size)})` }}
    />
  )
}

/**
 * Each author's Gravatar lookup, asked of the backend once per session; the
 * backend keeps the answers on disk across sessions.
 */
const gravatars = new Map<string, Promise<string>>()

const gravatarOf = (email: string) => {
  let picture = gravatars.get(email)
  if (!picture) {
    picture = appRuntime.runPromise(Rpc.use((rpc) => rpc.gravatar(email)).pipe(Effect.orElseSucceed(() => "")))
    gravatars.set(email, picture)
  }
  return picture
}

const patterns = new Map<string, string>()

/** The author's dither pattern as an image, made once per author and size. */
const pattern = (key: string, size: number) => {
  const id = `${key}\n${size}`
  let url = patterns.get(id)
  if (!url) {
    url = createHashvatar({ hash: key, size, mode: "dither" }).canvas.toDataURL()
    patterns.set(id, url)
  }
  return url
}
