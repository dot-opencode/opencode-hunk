import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { TOOLS, executeTool, formatResult } from "../src/tools.ts"
import { describeFailure, noSessionMessage, runHunk, type RunResult } from "../src/hunk.ts"

const spec = (name: string) => TOOLS.find((t) => t.name === name)!
const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0 })

describe("tool specs", () => {
  test("all tools present with schemas", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "sessions", "review", "context", "navigate", "comment", "comments", "comment_remove", "highlight", "reload",
    ])
    for (const t of TOOLS) {
      expect((t.schema as any).type).toBe("object")
      expect(t.description).toContain("/hunk")
      if (t.targeted) {
        expect((t.schema as any).properties.repo).toBeDefined()
        expect((t.schema as any).properties.session).toBeDefined()
      }
    }
  })
})

describe("executeTool", () => {
  test("defaults repo to directory and passes cwd/stdin", async () => {
    let seen: any
    const text = await executeTool(spec("comment"), { comments: [{ replyTo: "u:1", summary: "ok" }] }, { directory: "/d", bin: "hk" }, undefined, async (args, o) => {
      seen = { args, o }
      return ok('{"result":{"applied":[]}}')
    })
    expect(seen.args).toEqual(["session", "comment", "apply", "--repo", "/d", "--stdin", "--json"])
    expect(seen.o.cwd).toBe("/d")
    expect(seen.o.bin).toBe("hk")
    expect(JSON.parse(seen.o.stdin)).toEqual({ comments: [{ summary: "ok", replyTo: "u:1" }] })
    expect(JSON.parse(text)).toEqual({ result: { applied: [] } })
  })
  test("explicit repo and session", async () => {
    let args: readonly string[] = []
    await executeTool(spec("context"), { repo: tmpdir() }, { directory: "/d" }, undefined, async (a) => ((args = a), ok("{}")))
    expect(args).toEqual(["session", "context", "--repo", tmpdir(), "--json"])
    await executeTool(spec("context"), { repo: "/x", session: "s9" }, { directory: "/d" }, undefined, async (a) => ((args = a), ok("{}")))
    expect(args).toEqual(["session", "context", "s9", "--json"])
  })
  test("validation errors never shell out", async () => {
    let called = false
    const text = await executeTool(spec("navigate"), { file: "a", hunk: 1, newLine: 1 }, { directory: "/d" }, undefined, async () => ((called = true), ok("")))
    expect(called).toBe(false)
    expect(text).toStartWith("Error:")
  })
  test("sessions ignores repo", async () => {
    let args: readonly string[] = []
    await executeTool(spec("sessions"), {}, { directory: "/d" }, undefined, async (a) => ((args = a), ok('{"sessions":[]}')))
    expect(args).toEqual(["session", "list", "--json"])
  })
})

describe("protocol-validation-failed mapping", () => {
  const failed: RunResult = { stdout: "", stderr: "hunk: protocol-validation-failed\n", code: 1 }
  test("describeFailure maps it to the no-session hint", () => {
    const msg = describeFailure(failed)!
    expect(msg).toContain("No active Hunk session")
    expect(msg).toContain("/hunk")
  })
  test("tool checks session list and returns the hint when empty", async () => {
    const calls: string[][] = []
    const text = await executeTool(spec("comment"), { comments: [{ replyTo: "user:1", summary: "x" }] }, { directory: "/d" }, undefined, async (args) => {
      calls.push([...args])
      return args[1] === "list" ? ok('{"sessions":[]}') : failed
    })
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["session comment", "session list"])
    expect(text).toStartWith("Error: No active Hunk session")
    expect(text).toContain("/hunk")
  })
  test("tool lists live sessions when others exist", async () => {
    const text = await executeTool(spec("context"), {}, { directory: "/d" }, undefined, async (args) =>
      args[1] === "list" ? ok('{"sessions":[{"sessionId":"abc","repoRoot":"/other","title":"t"}]}') : failed,
    )
    expect(text).toContain("abc")
    expect(text).toContain("/other")
    expect(text).toContain("`session`")
  })
  test("unrelated errors do not trigger the lookup", async () => {
    const calls: string[][] = []
    const text = await executeTool(spec("context"), {}, { directory: "/d" }, undefined, async (args) => {
      calls.push([...args])
      return { stdout: "", stderr: "hunk: No diff file matches x", code: 1 }
    })
    expect(calls).toHaveLength(1)
    expect(text).toBe("Error: hunk: No diff file matches x")
  })
  test("daemon mismatch note", () => {
    expect(describeFailure({ stdout: "", stderr: "The session daemon is older than this build", code: 1 })).toContain("daemon restart")
  })
})

describe("failures", () => {
  test("no session hints at /hunk", () => {
    const msg = describeFailure({ stdout: "", stderr: "No active Hunk sessions are registered with the daemon. Open Hunk and wait for it to connect.", code: 1 })!
    expect(msg).toContain("/hunk")
  })
  test("json error", () => {
    const msg = describeFailure({ stdout: "", stderr: JSON.stringify({ error: "Multiple active sessions match" }), code: 1 })!
    expect(msg).toBe("Multiple active sessions match")
  })
  test("missing binary", () => {
    expect(describeFailure({ stdout: "", stderr: "", code: -1, failure: "not-found" }, "hunk")).toContain("Could not find")
  })
  test("success is undefined", () => expect(describeFailure(ok("{}"))).toBeUndefined())
  test("formatResult prettifies JSON and passes text", () => {
    expect(formatResult(ok('{"a":1}'))).toBe('{\n  "a": 1\n}')
    expect(formatResult(ok("plain\n"))).toBe("plain")
    expect(formatResult(ok(""))).toBe("OK")
  })
})

describe("runHunk", () => {
  test("reports ENOENT", async () => {
    const r = await runHunk([], { bin: "definitely-not-a-binary-xyz" })
    expect(r.failure).toBe("not-found")
  })
  test("captures stdout, stdin and exit code", async () => {
    const r = await runHunk([], { bin: "cat", stdin: "hello" })
    expect(r).toMatchObject({ stdout: "hello", code: 0 })
    const f = await runHunk(["--nope-flag"], { bin: "ls" })
    expect(f.code).not.toBe(0)
  })
  test("timeout", async () => {
    const r = await runHunk(["5"], { bin: "sleep", timeoutMs: 100 })
    expect(r.failure).toBe("timeout")
  })
  test("real hunk with no session", async () => {
    const r = await runHunk(["--version"], {})
    expect(r.code === 0 || r.failure === "not-found").toBe(true)
  })
})

describe("runHunk kill escalation", () => {
  test("SIGTERM-ignoring child resolves within timeout + grace", async () => {
    const t0 = Date.now()
    const r = await runHunk(["-c", 'trap "" TERM; sleep 10'], { bin: "bash", timeoutMs: 200, killGraceMs: 300 })
    expect(r.failure).toBe("timeout")
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  test("abort escalates too", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    const r = await runHunk(["-c", 'trap "" TERM; sleep 10'], { bin: "bash", signal: ac.signal, killGraceMs: 300 })
    expect(r.failure).toBe("aborted")
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  test("pre-aborted signal", async () => {
    const ac = new AbortController()
    ac.abort()
    expect((await runHunk([], { bin: "cat", signal: ac.signal })).failure).toBe("aborted")
  })
})

describe("executeTool failure paths", () => {
  test("timeout, abort and spawn failure are reported", async () => {
    for (const failure of ["timeout", "aborted", "spawn"] as const) {
      const text = await executeTool(spec("context"), {}, { directory: "/d" }, undefined, async () => ({
        stdout: "", stderr: "", code: null, failure, failureMessage: `boom-${failure}`,
      }))
      expect(text).toBe(`Error: hunk failed: boom-${failure}`)
    }
  })
  test("bad repo is an input error, not a missing binary", async () => {
    let called = false
    const text = await executeTool(spec("context"), { repo: "/no/such/dir" }, { directory: "/d" }, undefined, async () => ((called = true), ok("")))
    expect(called).toBe(false)
    expect(text).toContain("not an existing directory")
  })
  test("cwd stays the runtime directory", async () => {
    let cwd: string | undefined
    await executeTool(spec("context"), { repo: tmpdir() }, { directory: "/d" }, undefined, async (_a, o) => ((cwd = o?.cwd), ok("{}")))
    expect(cwd).toBe("/d")
  })
  test("real spawn failure through runHunk", async () => {
    const text = await executeTool(spec("context"), {}, { directory: "/d", bin: "definitely-not-a-binary-xyz" })
    expect(text).toContain("Could not find")
  })
})

describe("ambiguity and messages", () => {
  const failed: RunResult = { stdout: "", stderr: "hunk: protocol-validation-failed", code: 1 }
  test("2+ matching sessions are reported as ambiguous", async () => {
    const dir = tmpdir()
    const list = JSON.stringify({ sessions: [{ sessionId: "a", repoRoot: dir }, { sessionId: "b", repoRoot: dir }, { sessionId: "c", repoRoot: "/o" }] })
    const text = await executeTool(spec("context"), { repo: dir }, { directory: "/d" }, undefined, async (args) =>
      args[1] === "list" ? ok(list) : failed,
    )
    expect(text).toContain("Ambiguous: 2 sessions match this repo; pass `session`")
  })
  test("noSessionMessage mentions the selected session", () => {
    expect(noSessionMessage([], undefined, "s42")).toContain("s42")
    expect(noSessionMessage([{ sessionId: "x" }], undefined, "s42")).toContain("session s42")
  })
  test("user vs model wording", () => {
    const model = describeFailure(failed, "hunk", "model")!
    const user = describeFailure(failed, "hunk", "user")!
    expect(model).toContain("Do not launch the Hunk TUI")
    expect(user).not.toContain("Do not launch")
    expect(user).not.toContain("protocol-validation-failed")
    const daemon = { stdout: "", stderr: "daemon build mismatch", code: 1 }
    expect(describeFailure(daemon, "hunk", "model")).toContain("Ask the user")
    expect(describeFailure(daemon, "hunk", "user")).not.toContain("Ask the user")
  })
  test("unknown session command needs hunk >= 0.23", () => {
    expect(describeFailure({ stdout: "", stderr: "Unknown command: session", code: 1 })).toContain("hunk >= 0.23 required")
  })
  test("hunk_sessions projects fields", async () => {
    const raw = JSON.stringify({ sessions: [{ sessionId: "a", repoRoot: "/r", cwd: "/c", title: "t", sourceLabel: "s", fileCount: 2, launchedAt: "2026-01-01", secret: "x", files: [1] }] })
    const text = await executeTool(spec("sessions"), {}, { directory: "/d" }, undefined, async () => ok(raw))
    expect(JSON.parse(text).sessions[0]).toEqual({ sessionId: "a", repoRoot: "/r", cwd: "/c", title: "t", sourceLabel: "s", fileCount: 2, launchedAt: "2026-01-01" })
  })
  test("mutating tools declare a permission", () => {
    expect(spec("reload").permission).toBe("hunk_reload")
    expect(spec("comment_remove").permission).toBe("hunk_comment_remove")
  })
})
