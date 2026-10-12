/** Asks for both sides of a file to be highlighted. */
export interface HighlightRequest {
  readonly id: number
  readonly path: string
  readonly texts: ReadonlyArray<string>
}

/** One token array per text, or null when the language is not highlighted. */
export interface HighlightResponse {
  readonly id: number
  readonly sides: ReadonlyArray<Int32Array> | null
}

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, (sides: ReadonlyArray<Int32Array> | null) => void>()

const getWorker = () => {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "highlight" })
    worker.onmessage = ({ data }: MessageEvent<HighlightResponse>) => {
      pending.get(data.id)?.(data.sides)
      pending.delete(data.id)
    }
  }
  return worker
}

/**
 * Highlights texts of one file off the main thread. Requests are answered in
 * order, and a caller that no longer needs an answer simply ignores it.
 */
export const highlight = (path: string, texts: ReadonlyArray<string>): Promise<ReadonlyArray<Int32Array> | null> =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    getWorker().postMessage({ id, path, texts } satisfies HighlightRequest)
  })
