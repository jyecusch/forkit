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

const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" })
const pad = (n: number) => String(n).padStart(2, "0")

/** The complete local date and time, for tooltips. */
export const formatFullDate = (millis: number) => full.format(new Date(millis))

/**
 * Formats a unix-millisecond time in the user's chosen style, in local
 * time. Times slightly in the future, from clock skew between machines,
 * read as "just now" rather than "in 2 days".
 */
export const formatDate = (millis: number, style: DateFormat, now = Date.now()): string => {
  const date = new Date(millis)
  switch (style) {
    case "iso":
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    case "absolute":
      return (date.getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear).format(date)
    case "relative": {
      const seconds = Math.min(Math.round((millis - now) / 1000), 0)
      for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) {
          return relative.format(Math.round(seconds / size), unit)
        }
      }
      return "just now"
    }
  }
}

export const shortOid = (oid: string): string => oid.slice(0, 7)

/** The last path segment, for showing a worktree by its folder name. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * Joins the hard-wrapped lines of a commit message into paragraphs, so the
 * text wraps to the space it is shown in. Blank lines, list items, quotes,
 * indented lines and fenced code keep their line breaks.
 */
export const reflow = (text: string): string => {
  const lines: Array<string> = []
  let fenced = false
  let joinable = false
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const verbatim = fenced || /^\s*```/.test(line) || /^(\s|>)/.test(line)
    const blank = line.trim() === ""
    if (joinable && !verbatim && !blank && !/^([-*+]|\d+[.)])\s/.test(line)) {
      lines[lines.length - 1] += ` ${line.trim()}`
    } else {
      lines.push(line)
    }
    joinable = !verbatim && !blank
  }
  return lines.join("\n")
}
