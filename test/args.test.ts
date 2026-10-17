import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import {
  InputError,
  buildComment,
  buildCommentRemove,
  buildComments,
  buildContext,
  buildHighlight,
  buildNavigate,
  buildReload,
  buildReview,
  buildSessions,
  readSelector,
} from "../src/args.ts"

const repoSel = { repo: "/r" }

describe("selector", () => {
  test("defaults to repo", () => expect(readSelector({}, "/d")).toEqual({ repo: "/d" }))
  test("session overrides repo", () => expect(readSelector({ session: "abc", repo: "/x" }, "/d")).toEqual({ session: "abc" }))
  test("explicit repo", () => expect(readSelector({ repo: tmpdir() }, "/d")).toEqual({ repo: tmpdir() }))
  test("rejects a repo that is not a directory", () => expect(() => readSelector({ repo: "/definitely/not/here" }, "/d")).toThrow(InputError))
  test("rejects dash-prefixed session", () => expect(() => readSelector({ session: "--repo" }, "/d")).toThrow(InputError))
  test("rejects dash-prefixed comment and id", () => {
    expect(() => buildNavigate({ comment: "--json" }, repoSel)).toThrow(InputError)
    expect(() => buildCommentRemove({ id: "-x" }, repoSel)).toThrow(InputError)
  })
})

describe("reload flag rejection", () => {
  for (const flag of ["--extension", "--enable-extension", "--disable-extension", "--no-extensions", "--agent-context", "--files"]) {
    test(flag, () => {
      expect(() => buildReload({ args: ["diff", flag] }, repoSel)).toThrow(InputError)
      expect(() => buildReload({ args: ["diff", `${flag}=x`] }, repoSel)).toThrow(InputError)
    })
  }
  test("paths after -- are allowed", () => {
    expect(buildReload({ args: ["diff", "--", "--files"] }, repoSel).args.at(-1)).toBe("--files")
  })
})

describe("simple builders", () => {
  test("sessions", () => expect(buildSessions().args).toEqual(["session", "list", "--json"]))
  test("context", () => expect(buildContext(repoSel).args).toEqual(["session", "context", "--repo", "/r", "--json"]))
  test("context with session id", () => expect(buildContext({ session: "s1" }).args).toEqual(["session", "context", "s1", "--json"]))
  test("review flags", () =>
    expect(buildReview({ includePatch: true, includeNotes: true }, repoSel).args).toEqual([
      "session", "review", "--repo", "/r", "--include-patch", "--include-notes", "--json",
    ]))
  test("review default", () => expect(buildReview({}, repoSel).args).toEqual(["session", "review", "--repo", "/r", "--json"]))
})

describe("navigate", () => {
  test("file + hunk", () =>
    expect(buildNavigate({ file: "a.ts", hunk: 2 }, repoSel).args).toEqual([
      "session", "navigate", "--repo", "/r", "--file", "a.ts", "--hunk", "2", "--json",
    ]))
  test("file + newLine", () => expect(buildNavigate({ file: "a.ts", newLine: 5 }, repoSel).args).toContain("--new-line"))
  test("file + oldLine", () => expect(buildNavigate({ file: "a.ts", oldLine: 5 }, repoSel).args).toContain("--old-line"))
  test("comment", () =>
    expect(buildNavigate({ comment: "c1" }, { session: "s" }).args).toEqual(["session", "navigate", "s", "--comment", "c1", "--json"]))
  test("next/prev", () => {
    expect(buildNavigate({ direction: "next" }, repoSel).args).toContain("--next-comment")
    expect(buildNavigate({ direction: "prev" }, repoSel).args).toContain("--prev-comment")
  })
  test("rejects two line targets", () => expect(() => buildNavigate({ file: "a", hunk: 1, newLine: 2 }, repoSel)).toThrow(InputError))
  test("rejects file without target", () => expect(() => buildNavigate({ file: "a" }, repoSel)).toThrow(InputError))
  test("rejects target without file", () => expect(() => buildNavigate({ hunk: 1 }, repoSel)).toThrow(/file/))
  test("rejects nothing", () => expect(() => buildNavigate({}, repoSel)).toThrow(InputError))
  test("rejects mixed modes", () => expect(() => buildNavigate({ comment: "c", direction: "next" }, repoSel)).toThrow(InputError))
  test("rejects bad direction", () => expect(() => buildNavigate({ direction: "up" }, repoSel)).toThrow(InputError))
  test("rejects non-positive hunk", () => expect(() => buildNavigate({ file: "a", hunk: 0 }, repoSel)).toThrow(InputError))
})

describe("comment (batch)", () => {
  test("builds stdin JSON", () => {
    const cmd = buildComment(
      {
        focus: true,
        comments: [
          { filePath: "README.md", newLine: 3, summary: "Tighten", rationale: "why" },
          { filePath: "a.ts", hunk: 2, summary: "x" },
          { replyTo: "user:1", summary: "done" },
        ],
      },
      repoSel,
    )
    expect(cmd.args).toEqual(["session", "comment", "apply", "--repo", "/r", "--stdin", "--focus", "--json"])
    expect(JSON.parse(cmd.stdin!)).toEqual({
      comments: [
        { summary: "Tighten", rationale: "why", filePath: "README.md", newLine: 3 },
        { summary: "x", filePath: "a.ts", hunk: 2 },
        { summary: "done", replyTo: "user:1" },
      ],
    })
  })
  test("rejects empty", () => expect(() => buildComment({ comments: [] }, repoSel)).toThrow(InputError))
  test("rejects missing comments", () => expect(() => buildComment({}, repoSel)).toThrow(InputError))
  test("rejects root without target", () => expect(() => buildComment({ comments: [{ filePath: "a", summary: "s" }] }, repoSel)).toThrow(/comments\[0\]/))
  test("rejects two targets", () =>
    expect(() => buildComment({ comments: [{ filePath: "a", hunk: 1, newLine: 2, summary: "s" }] }, repoSel)).toThrow(InputError))
  test("rejects reply with file", () =>
    expect(() => buildComment({ comments: [{ replyTo: "x", filePath: "a", summary: "s" }] }, repoSel)).toThrow(InputError))
  test("rejects missing summary", () => expect(() => buildComment({ comments: [{ filePath: "a", newLine: 1 }] }, repoSel)).toThrow(/summary/))
  test("rejects file-less root", () => expect(() => buildComment({ comments: [{ newLine: 1, summary: "s" }] }, repoSel)).toThrow(InputError))
  test("reports index of bad item", () =>
    expect(() => buildComment({ comments: [{ replyTo: "a", summary: "s" }, { summary: "s" }] }, repoSel)).toThrow(/comments\[1\]/))
})

describe("comments / remove", () => {
  test("list defaults", () => expect(buildComments({}, repoSel).args).toEqual(["session", "comment", "list", "--repo", "/r", "--json"]))
  test("list type+file", () =>
    expect(buildComments({ type: "user", file: "a.ts" }, repoSel).args).toEqual([
      "session", "comment", "list", "--repo", "/r", "--file", "a.ts", "--type", "user", "--json",
    ]))
  test("list bad type", () => expect(() => buildComments({ type: "nope" }, repoSel)).toThrow(InputError))
  test("remove with repo", () => expect(buildCommentRemove({ id: "c1" }, repoSel).args).toEqual(["session", "comment", "rm", "--repo", "/r", "c1", "--json"]))
  test("remove with session", () => expect(buildCommentRemove({ id: "c1" }, { session: "s" }).args).toEqual(["session", "comment", "rm", "s", "c1", "--json"]))
  test("remove requires id", () => expect(() => buildCommentRemove({}, repoSel)).toThrow(InputError))
})

describe("highlight", () => {
  test("add", () =>
    expect(buildHighlight({ file: "a.ts", newLine: 4, start: 1, end: 5, tone: "warning", focus: true }, repoSel).args).toEqual([
      "session", "highlight", "add", "--repo", "/r", "--file", "a.ts", "--new-line", "4", "--start", "1", "--end", "5", "--tone", "warning", "--focus", "--json",
    ]))
  test("clear", () =>
    expect(buildHighlight({ action: "clear", file: "a.ts" }, repoSel).args).toEqual(["session", "highlight", "clear", "--repo", "/r", "--file", "a.ts", "--json"]))
  test("clear all", () => expect(buildHighlight({ action: "clear" }, repoSel).args).toEqual(["session", "highlight", "clear", "--repo", "/r", "--json"]))
  test("exactly one line", () => expect(() => buildHighlight({ file: "a", start: 0, end: 1 }, repoSel)).toThrow(InputError))
  test("both lines rejected", () => expect(() => buildHighlight({ file: "a", oldLine: 1, newLine: 1, start: 0, end: 1 }, repoSel)).toThrow(InputError))
  test("end > start", () => expect(() => buildHighlight({ file: "a", newLine: 1, start: 3, end: 3 }, repoSel)).toThrow(/greater/))
  test("bad tone", () => expect(() => buildHighlight({ file: "a", newLine: 1, start: 0, end: 1, tone: "x" }, repoSel)).toThrow(InputError))
  test("bad action", () => expect(() => buildHighlight({ action: "rm" }, repoSel)).toThrow(InputError))
})

describe("reload", () => {
  test("diff --staged", () =>
    expect(buildReload({ args: ["diff", "--staged"] }, repoSel).args).toEqual(["session", "reload", "--repo", "/r", "--json", "--", "diff", "--staged"]))
  test("show with pathspec and source", () =>
    expect(buildReload({ args: ["show", "HEAD~1", "--", "README.md"], source: "/s" }, { session: "s1" }).args).toEqual([
      "session", "reload", "s1", "--source", "/s", "--json", "--", "show", "HEAD~1", "--", "README.md",
    ]))
  test("rejects non diff/show", () => expect(() => buildReload({ args: ["pager"] }, repoSel)).toThrow(InputError))
  test("rejects empty", () => expect(() => buildReload({ args: [] }, repoSel)).toThrow(InputError))
  test("rejects non-string", () => expect(() => buildReload({ args: ["diff", 1] }, repoSel)).toThrow(InputError))
})
