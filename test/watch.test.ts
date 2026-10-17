import { describe, expect, test } from "bun:test"
import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WatchRegistry, watchRepo } from "../src/watch.ts"
import { newestSession, type ListedSession } from "../src/hunk.ts"
import { runSuspended, runTmux, type SpawnFn } from "../src/suspend.ts"
import { EventEmitter } from "node:events"

const base = { pollMs: 5, startTimeoutMs: 1000 }

describe("watchRepo", () => {
  test("ignores pre-existing sessions and caches [] after comments are deleted", async () => {
    const old: ListedSession = { sessionId: "old", repoRoot: "/r", launchedAt: "2026-01-01T00:00:00Z" }
    const fresh: ListedSession = { sessionId: "new", repoRoot: "/r", launchedAt: "2026-02-01T00:00:00Z" }
    let tick = 0
    const fetched: string[] = []
    let closedWith: unknown
    await watchRepo(
      {
        listSessions: async () => {
          tick++
          if (tick < 3) return [old]
          if (tick < 6) return [old, fresh]
          return [old]
        },
        fetchComments: async (id) => {
          fetched.push(id)
          return tick < 5 ? [{ id: "c" } as any] : []
        },
      },
      {
        ...base,
        repo: "/r",
        ignoreSessionIds: new Set(["old"]),
        signal: new AbortController().signal,
        onTimeout: () => {},
        onClosed: (c) => void (closedWith = c),
      },
    )
    expect(new Set(fetched)).toEqual(new Set(["new"]))
    expect(closedWith).toEqual([])
  })
  test("picks the newest matching session", () => {
    expect(newestSession([{ sessionId: "a", launchedAt: "2026-01-01" }, { sessionId: "b", launchedAt: "2026-03-01" }, { sessionId: "c" }])?.sessionId).toBe("b")
  })
})

describe("WatchRegistry", () => {
  test("normalizes symlinked repo paths", () => {
    const real = mkdtempSync(join(tmpdir(), "wr-"))
    const link = real + "-link"
    symlinkSync(real, link)
    const reg = new WatchRegistry()
    expect(reg.start(real, () => new Promise(() => {}))).toBe(true)
    expect(reg.start(link, () => new Promise(() => {}))).toBe(false)
    expect(reg.has(link)).toBe(true)
    reg.stopAll()
  })
})

function fakeSpawn(code: number | null, stderr = ""): SpawnFn {
  return () => {
    const child: any = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = () => {}
    setTimeout(() => {
      if (stderr) child.stderr.emit("data", stderr)
      child.emit("close", code)
    }, 10)
    return child
  }
}

describe("runSuspended", () => {
  const renderer = () => {
    const calls: string[] = []
    return { calls, suspend: () => calls.push("suspend"), resume: () => calls.push("resume") }
  }
  test("resolves with the exit code and resumes", async () => {
    const r = renderer()
    const res = await runSuspended({ renderer: r, bin: "hunk", args: [], cwd: "/", pollMs: 1000, fetchComments: async () => [], spawn: fakeSpawn(3) })
    expect(res.code).toBe(3)
    expect(r.calls).toEqual(["suspend", "resume"])
  })
  test("a successful empty fetch clears the cache", async () => {
    let n = 0
    const res = await runSuspended({
      renderer: renderer(),
      bin: "hunk",
      args: [],
      cwd: "/",
      pollMs: 2,
      fetchComments: async () => (++n === 1 ? [{ id: "x" } as any] : []),
      spawn: (...a) => {
        const c = fakeSpawn(0)(...a)
        return c
      },
    })
    expect(n).toBeGreaterThan(1)
    expect(res.comments).toEqual([])
    expect(res.code).toBe(0)
  })
  test("spawn error rejects and resumes", async () => {
    const r = renderer()
    const spawnFn: SpawnFn = () => {
      const c: any = new EventEmitter()
      setTimeout(() => c.emit("error", new Error("nope")), 5)
      return c
    }
    await expect(runSuspended({ renderer: r, bin: "x", args: [], cwd: "/", pollMs: 1000, fetchComments: async () => [], spawn: spawnFn })).rejects.toThrow("nope")
    expect(r.calls).toEqual(["suspend", "resume"])
  })
})

describe("runTmux", () => {
  test("includes stderr in the error", async () => {
    await expect(runTmux(["split-window"], fakeSpawn(1, "no server running\n"))).rejects.toThrow("tmux exited with code 1: no server running")
  })
  test("ok", async () => {
    await runTmux([], fakeSpawn(0))
  })
})
