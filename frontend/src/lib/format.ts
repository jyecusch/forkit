import type { DateFormat } from "@/model/model.gen"

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const sameYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const otherYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" })

const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
]

/** Formats a unix-millisecond time in the user's chosen style. */
export const formatDate = (millis: number, style: DateFormat, now = Date.now()): string => {
  const date = new Date(millis)
  switch (style) {
    case "iso":
      return date.toISOString().slice(0, 16).replace("T", " ")
    case "absolute":
      return (date.getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear).format(date)
    case "relative": {
      const seconds = Math.round((millis - now) / 1000)
      for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) {
          return relative.format(Math.round(seconds / size), unit)
        }
      }
      return "just now"
    }
  }
}

/** Up to two initials from a name, for avatars. */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("")

export const shortOid = (oid: string): string => oid.slice(0, 7)

/** The last path segment, for showing a worktree by its folder name. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
