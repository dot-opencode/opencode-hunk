import { describe, expect, test } from "bun:test"
import { appleScriptString, buildCommandText, buildGhosttyScript, describeOsascriptError, resolveBinPath, shellQuote } from "../src/ghostty.ts"
import { resolveMode, readTuiConfig } from "../src/open.ts"
import { WatchRegistry, watchRepo } from "../src/watch.ts"
import type { HunkComment } from "../src/comments.ts"
import type { ListedSession } from "../src/hunk.ts"

describe("resolveMode", () => {
  test("auto: tmux wins over ghostty", () => expect(resolveMode("auto", { TMUX: "x", TERM_PROGRAM: "ghostty" }, "darwin")).toBe("tmux"))
  test("auto: ghostty on darwin", () => expect(resolveMode("auto", { TERM_PROGRAM: "ghostty" }, "darwin")).toBe("ghostty"))
  test("auto: ghostty on linux falls back to suspend", () => expect(resolveMode("auto", { TERM_PROGRAM: "ghostty" }, "linux")).toBe("suspend"))
  test("auto: other terminal", () => expect(resolveMode("auto", { TERM_PROGRAM: "iTerm.app" }, "darwin")).toBe("suspend"))
  test("explicit modes are kept", () => {
    expect(resolveMode("ghostty", {}, "linux")).toBe("ghostty")
    expect(resolveMode("suspend", { TMUX: "x" }, "darwin")).toBe("suspend")
    expect(resolveMode("tmux", {}, "darwin")).toBe("tmux")
  })
  test("config accepts ghostty", () => expect(readTuiConfig({ mode: "ghostty" }).mode).toBe("ghostty"))
})

describe("appleScriptString", () => {
  test("plain", () => expect(appleScriptString("abc")).toBe('"abc"'))
  test("escapes backslash before quote", () => expect(appleScriptString('a\\b"c')).toBe('"a\\\\b\\"c"'))
  test("escapes control chars", () => expect(appleScriptString("a\nb\tc\r")).toBe('"a\\nb\\tc\\r"'))
  test("injection attempt stays inside the literal", () => {
    const out = appleScriptString('x" & (do shell script "id") & "')
    expect(out).toBe('"x\\" & (do shell script \\"id\\") & \\""')
  })
})

describe("shellQuote / buildCommandText", () => {
  test("safe words untouched", () => expect(shellQuote("--staged")).toBe("--staged"))
  test("ranges and paths untouched", () => {
    expect(shellQuote("main...HEAD")).toBe("main...HEAD")
    expect(shellQuote("/opt/homebrew/bin/hunk")).toBe("/opt/homebrew/bin/hunk")
  })
  test("spaces and metachars quoted", () => {
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("$(rm -rf)")).toBe("'$(rm -rf)'")
    expect(shellQuote("a;b|c&d")).toBe("'a;b|c&d'")
  })
  test("single quotes", () => expect(shellQuote("it's")).toBe(`'it'\\''s'`))
  test("empty", () => expect(shellQuote("")).toBe("''"))
  test("command text", () => expect(buildCommandText("/opt/hunk", ["diff", "--staged", "my file"])).toBe("/opt/hunk diff --staged 'my file'"))
})

describe("buildGhosttyScript", () => {
  const script = buildGhosttyScript({ cwd: '/re"po', bin: "/opt/homebrew/bin/hunk", args: ["diff", "--staged"], path: "/usr/bin:/bin" })
  test("targets Ghostty with record literal", () => {
    expect(script).toContain('tell application "Ghostty"')
    expect(script).toContain('new tab in front window with configuration {')
    expect(script).toContain('initial working directory:"/re\\"po"')
    expect(script).toContain('command:"/opt/homebrew/bin/hunk diff --staged"')
    expect(script).toContain("wait after command:false")
    expect(script).toContain('environment variables:{"PATH=/usr/bin:/bin"}')
  })
  test("falls back to a new window when none is open", () => expect(script).toContain("new window with configuration"))
  test("PATH omitted when undefined", () => expect(buildGhosttyScript({ cwd: "/r", bin: "hunk", args: [] })).not.toContain("environment variables"))
})

describe("resolveBinPath", () => {
  test("finds on PATH", () => expect(resolveBinPath("sh", { PATH: "/nonexistent:/bin" })).toBe("/bin/sh"))
  test("absolute untouched", () => expect(resolveBinPath("/x/hunk")).toBe("/x/hunk"))
  test("relative with slash resolved against cwd", () => expect(resolveBinPath("./h", {}, "/w")).toBe("/w/h"))
  test("not found returns input", () => expect(resolveBinPath("definitely-not-here-xyz", { PATH: "/bin" })).toBe("definitely-not-here-xyz"))
})

describe("describeOsascriptError", () => {
  test("-1743", () => expect(describeOsascriptError("execution error: Not authorized to send Apple events to Ghostty. (-1743)")).toContain("Automation"))
  test("other", () => expect(describeOsascriptError(" boom \n")).toBe("boom"))
  test("empty", () => expect(describeOsascriptError("")).toBe("osascript failed"))
})

const sess = (id: string, repo: string): ListedSession => ({ sessionId: id, repoRoot: repo })
const cmt = (id: string): HunkComment => ({ id, filePath: "f", summary: "s" })

describe("watchRepo", () => {
  test("waits for session, caches comments, reports close", async () => {
    const script: (ListedSession[] | undefined)[] = [[], [sess("a", "/r")], [sess("a", "/r")], undefined, [sess("a", "/r")], []]
    const comments: HunkComment[][] = [[], [cmt("1")], [cmt("1"), cmt("2")]]
    let closed: HunkComment[] | undefined
    const controller = new AbortController()
    await watchRepo(
      { listSessions: async () => script.shift(), fetchComments: async () => comments.shift() ?? [] },
      { repo: "/r", pollMs: 1, startTimeoutMs: 1000, signal: controller.signal, onTimeout: () => {}, onClosed: (c) => { closed = c } },
    )
    expect(closed?.map((c) => c.id)).toEqual(["1", "2"])
  })
  test("times out when no session appears", async () => {
    let timedOut = false
    await watchRepo(
      { listSessions: async () => [sess("other", "/elsewhere")], fetchComments: async () => [] },
      { repo: "/r", pollMs: 5, startTimeoutMs: 20, signal: new AbortController().signal, onTimeout: () => { timedOut = true }, onClosed: () => { throw new Error("no") } },
    )
    expect(timedOut).toBe(true)
  })
  test("abort stops quietly", async () => {
    const controller = new AbortController()
    let called = false
    const p = watchRepo(
      { listSessions: async () => [], fetchComments: async () => [] },
      { repo: "/r", pollMs: 5, startTimeoutMs: 100000, signal: controller.signal, onTimeout: () => { called = true }, onClosed: () => { called = true } },
    )
    setTimeout(() => controller.abort(), 20)
    await p
    expect(called).toBe(false)
  })
})

describe("WatchRegistry", () => {
  test("one watcher per repo; stopAll aborts", async () => {
    const registry = new WatchRegistry()
    let aborted = false
    expect(registry.start("/r", (signal) => new Promise<void>((res) => signal.addEventListener("abort", () => ((aborted = true), res())))) ).toBe(true)
    expect(registry.start("/r", async () => {})).toBe(false)
    expect(registry.has("/r")).toBe(true)
    expect(registry.start("/other", async () => {})).toBe(true)
    registry.stopAll()
    await Promise.resolve()
    expect(aborted).toBe(true)
    expect(registry.has("/r")).toBe(false)
  })
  test("frees the slot when the run ends", async () => {
    const registry = new WatchRegistry()
    registry.start("/r", async () => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(registry.has("/r")).toBe(false)
  })
})
