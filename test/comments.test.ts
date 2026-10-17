import { describe, expect, test } from "bun:test"
import { formatCommentsPrompt, onlyUser, parseCommentList } from "../src/comments.ts"
import { buildListUserCommentsArgs, buildTmuxArgs, parseOpenInput, readTuiConfig, resolveMode } from "../src/open.ts"
import { splitArgs } from "../src/hunk.ts"

describe("parseCommentList", () => {
  test("live comment shape", () => {
    const out = parseCommentList({
      comments: [
        { commentId: "c1", filePath: "a.ts", hunkIndex: 1, side: "new", line: 12, summary: "rename", rationale: "clarity", author: "me", createdAt: "x" },
      ],
    })
    expect(out).toEqual([{ id: "c1", filePath: "a.ts", hunk: 2, side: "new", line: 12, summary: "rename", rationale: "clarity", author: "me" }])
  })
  test("review note shape (user)", () => {
    const out = parseCommentList({
      comments: [{ noteId: "user:1", source: "user", filePath: "a.ts", hunkIndex: 0, newRange: [5, 7], body: "why?", createdAt: "x", editable: true }],
    })
    expect(out[0]).toMatchObject({ id: "user:1", source: "user", side: "new", line: 5, endLine: 7, summary: "why?", hunk: 1 })
  })
  test("old-range only", () => {
    const out = parseCommentList([{ noteId: "n", filePath: "f", oldRange: [3, 3], body: "b" }])
    expect(out[0]).toMatchObject({ side: "old", line: 3 })
    expect(out[0]!.endLine).toBeUndefined()
  })
  test("tolerates garbage", () => {
    expect(parseCommentList(undefined)).toEqual([])
    expect(parseCommentList({ comments: "x" })).toEqual([])
    expect(parseCommentList({ comments: [null, 1, {}, { commentId: "a" }] })).toEqual([])
  })
  test("onlyUser filters", () => {
    const c = parseCommentList({
      comments: [
        { noteId: "a", source: "ai", filePath: "f", body: "x" },
        { noteId: "b", source: "user", filePath: "f", body: "y" },
        { commentId: "c", filePath: "f", side: "new", line: 1, summary: "z", hunkIndex: 0, createdAt: "" },
      ],
    })
    expect(onlyUser(c).map((x) => x.id)).toEqual(["b", "c"])
  })
})

describe("formatCommentsPrompt", () => {
  test("contains location, id, summary, rationale and reply hint", () => {
    const text = formatCommentsPrompt([
      { id: "user:1", filePath: "src/a.ts", side: "new", line: 10, summary: "Use a map", rationale: "O(1) lookup" },
      { id: "user:2", filePath: "src/b.ts", side: "old", line: 3, endLine: 4, summary: "Why removed?\nSecond line" },
    ])
    expect(text).toContain("2 review comments")
    expect(text).toContain("1. src/a.ts:10 (new side)")
    expect(text).toContain("comment id: user:1")
    expect(text).toContain("Use a map")
    expect(text).toContain("rationale: O(1) lookup")
    expect(text).toContain("src/b.ts:3-4 (old side")
    expect(text).toContain("   Second line")
    expect(text).toContain("hunk_comment")
    expect(text).toContain("replyTo")
  })
  test("singular", () => {
    expect(formatCommentsPrompt([{ id: "x", filePath: "f", summary: "s" }])).toContain("1 review comment in Hunk")
  })
})

describe("open helpers", () => {
  test("parseOpenInput", () => {
    expect(parseOpenInput(undefined)).toEqual(["diff", "--agent-notes"])
    expect(parseOpenInput("--staged")).toEqual(["diff", "--staged", "--agent-notes"])
    expect(parseOpenInput("main...HEAD")).toEqual(["diff", "main...HEAD", "--agent-notes"])
    expect(parseOpenInput("show HEAD~1")).toEqual(["show", "HEAD~1", "--agent-notes"])
    expect(parseOpenInput("diff --staged")).toEqual(["diff", "--staged", "--agent-notes"])
    expect(parseOpenInput("diff -- src")).toEqual(["diff", "--agent-notes", "--", "src"])
    expect(parseOpenInput("--no-agent-notes")).toEqual(["diff", "--no-agent-notes"])
  })
  test("splitArgs quotes", () => {
    expect(splitArgs(`a "b c" 'd e' f\\ g ""`)).toEqual(["a", "b c", "d e", "f g", ""])
  })
  test("resolveMode", () => {
    expect(resolveMode("auto", { TMUX: "/tmp/x" })).toBe("tmux")
    expect(resolveMode("auto", {})).toBe("suspend")
    expect(resolveMode("suspend", { TMUX: "1" })).toBe("suspend")
    expect(resolveMode("tmux", {})).toBe("tmux")
  })
  test("readTuiConfig", () => {
    expect(readTuiConfig(undefined)).toEqual({ bin: "hunk", mode: "auto", tmuxSplit: "-h", pollMs: 2000 })
    expect(readTuiConfig({ bin: "/x/hunk", mode: "tmux", tmuxSplit: "-v", pollMs: 500 })).toEqual({ bin: "/x/hunk", mode: "tmux", tmuxSplit: "-v", pollMs: 500 })
    expect(readTuiConfig({ mode: "bogus", tmuxSplit: "x", pollMs: 1 })).toEqual({ bin: "hunk", mode: "auto", tmuxSplit: "-h", pollMs: 2000 })
  })
  test("tmux + list args", () => {
    expect(buildTmuxArgs("-h", "/r", "hunk", ["diff", "--staged"])).toEqual(["split-window", "-h", "-c", "/r", "hunk", "diff", "--staged"])
    expect(buildListUserCommentsArgs("/r")).toEqual(["session", "comment", "list", "--repo", "/r", "--type", "user", "--json"])
  })
})
