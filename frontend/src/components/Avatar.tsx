import { createHashvatar } from "hashvatar"
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

interface AvatarProps {
  readonly name: string
  readonly email: string
  /** Width and height in CSS pixels. */
  readonly size: number
  readonly className?: string
}

/**
 * A commit author's picture: their Gravatar when they have one, otherwise a
 * dithered pattern made from their email, which is drawn at once and stays
 * underneath while the Gravatar loads.
 */
export const Avatar = ({ name, email, size, className }: AvatarProps) => {
  const key = email.trim().toLowerCase() || name
  const [gravatar, setGravatar] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let current = true
    setGravatar(undefined)
    setLoaded(false)
    if (!withoutGravatar.has(key)) void gravatarUrl(key).then((url) => current && setGravatar(url))
    return () => {
      current = false
    }
  }, [key])

  return (
    <span
      aria-hidden
      className={cn("relative inline-block flex-none overflow-hidden rounded-full", className)}
      style={{ width: size, height: size, backgroundImage: `url(${pattern(key, size)})`, backgroundSize: "cover" }}
    >
      {gravatar && (
        <img
          src={`${gravatar}?s=${Math.ceil(size * Math.max(devicePixelRatio, 2))}&d=404`}
          alt=""
          className={cn("absolute inset-0 size-full transition-opacity", loaded ? "opacity-100" : "opacity-0")}
          onLoad={() => setLoaded(true)}
          // Gravatar answers 404 for an email it does not know.
          onError={() => {
            withoutGravatar.add(key)
            setGravatar(undefined)
          }}
        />
      )}
    </span>
  )
}

/** Authors Gravatar has said it has no picture for, so it is not asked again. */
const withoutGravatar = new Set<string>()

const gravatarUrl = async (email: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `https://gravatar.com/avatar/${hex}`
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
