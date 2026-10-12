import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { GraphView, GraphWindow, RefId, RepoId } from "@/model/model.gen"
import { blockSize, GraphData } from "./GraphData"
import { Rpc } from "./Rpc"

const repo = "r" as RepoId

const view = (version: number, firstChangedRow = 0): GraphView => ({
  id: repo,
  version,
  totalRows: blockSize * 4,
  laneCount: 1,
  complete: true,
  firstChangedRow,
})

/** Answers graph window requests and records which starts were asked for. */
const fakeRpc = (requests: Array<number>, label: { current: string }) =>
  Layer.succeed(Rpc, {
    graphWindow: (_repo: RepoId, start: number, count: number) =>
      Effect.sync((): GraphWindow => {
        requests.push(start)
        const rows = Array.from({ length: count }, (_, i) => ({
          index: start + i,
          oid: `${label.current}${start + i}`,
          lane: 0,
          threadId: 0,
          edges: [],
          refIds: [],
          onEmphasized: false,
        }))
        return { version: 0, start, rows, commits: rows.map((r) => ({ oid: r.oid }) as never) } as unknown as GraphWindow
      }),
  } as unknown as Rpc["Service"])

describe("GraphData", () => {
  it.effect("fetches the blocks around the visible rows once", () => {
    const requests: Array<number> = []
    return Effect.gen(function* () {
      const data = yield* GraphData
      yield* data.ensure(repo, view(1), undefined, 600, 650)
      yield* data.ensure(repo, view(1), undefined, 600, 650)
      expect(requests.sort((a, b) => a - b)).toEqual([0, 500, 1000])
      expect(data.peek(repo, 620)?.row.index).toBe(620)
    }).pipe(Effect.provide(GraphData.layer.pipe(Layer.provide(fakeRpc(requests, { current: "a" })))))
  })

  it.effect("keeps blocks before the first changed row and refetches the rest", () => {
    const requests: Array<number> = []
    const label = { current: "old" }
    return Effect.gen(function* () {
      const data = yield* GraphData
      yield* data.ensure(repo, view(1), undefined, 0, 600)
      requests.length = 0
      label.current = "new"

      yield* data.ensure(repo, view(2, 700), undefined, 0, 600)
      expect(requests.sort((a, b) => a - b)).toEqual([500, 1000])
      expect(data.peek(repo, 10)?.commit.oid).toBe("old10")
      expect(data.peek(repo, 510)?.commit.oid).toBe("new510")
    }).pipe(Effect.provide(GraphData.layer.pipe(Layer.provide(fakeRpc(requests, label)))))
  })

  it.effect("refetches everything when emphasis changes", () => {
    const requests: Array<number> = []
    return Effect.gen(function* () {
      const data = yield* GraphData
      yield* data.ensure(repo, view(1), undefined, 0, 10)
      requests.length = 0
      yield* data.ensure(repo, view(1), "r:refs/heads/x" as RefId, 0, 10)
      expect(requests.sort((a, b) => a - b)).toEqual([0, 500])
    }).pipe(Effect.provide(GraphData.layer.pipe(Layer.provide(fakeRpc(requests, { current: "a" })))))
  })
})
