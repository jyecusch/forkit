/// <reference lib="webworker" />
import { languageOf, loadLanguage } from "./languages"
import { highlightLines } from "./tokens"
import type { HighlightRequest, HighlightResponse } from "./client"

/** Text past this size is left plain, so a huge generated file cannot stall highlighting. */
const maxLength = 8 * 1024 * 1024

// Highlights each side of a diff whole, so strings and comments that span
// lines are coloured correctly, and returns tokens as transferable arrays.
self.onmessage = async ({ data }: MessageEvent<HighlightRequest>) => {
  const name = languageOf(data.path)
  if (!name) {
    self.postMessage({ id: data.id, sides: null } satisfies HighlightResponse)
    return
  }
  try {
    const language = await loadLanguage(name)
    const sides = data.texts.map((text) => (text.length > maxLength ? new Int32Array() : highlightLines(language, text)))
    self.postMessage({ id: data.id, sides } satisfies HighlightResponse, { transfer: sides.map((side) => side.buffer) })
  } catch {
    // Unhighlighted text is still readable.
    self.postMessage({ id: data.id, sides: null } satisfies HighlightResponse)
  }
}
