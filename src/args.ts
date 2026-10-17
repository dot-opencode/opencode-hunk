/**
 * Pure argument builders + input validation for the `hunk_*` agent tools.
 * Every builder returns the argv for `hunk` (without the binary) and optional stdin,
 * or throws `InputError` with a message that is safe to show to the model.
 */

import { statSync } from "node:fs"

export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InputError"
  }
}

export interface Selector {
  /** Repo root / working directory used to match a live session (`--repo`). */
  repo?: string
  /** Exact session id (positional). Takes precedence over `repo`. */
  session?: string
}

export interface Command {
  args: string[]
  stdin?: string
}

type Obj = Record<string, unknown>

function obj(input: unknown): Obj {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InputError("Tool input must be an object.")
  }
  return input as Obj
}

function optString(o: Obj, key: string): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string" || v.trim() === "") throw new InputError(`\`${key}\` must be a non-empty string.`)
  return v
}

function reqString(o: Obj, key: string): string {
  const v = optString(o, key)
  if (v === undefined) throw new InputError(`\`${key}\` is required.`)
  return v
}

function optPositiveInt(o: Obj, key: string): number | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new InputError(`\`${key}\` must be a positive integer (1-based).`)
  return v
}

function optNonNegInt(o: Obj, key: string): number | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new InputError(`\`${key}\` must be a non-negative integer.`)
  return v
}

function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "boolean") throw new InputError(`\`${key}\` must be a boolean.`)
  return v
}

/** Like optString/reqString but rejects values that hunk's CLI parser would take for a flag. */
function noDash(value: string | undefined, key: string): string | undefined {
  if (value !== undefined && value.startsWith("-")) throw new InputError(`\`${key}\` must not start with "-".`)
  return value
}

/** Read the shared `repo` / `session` fields, defaulting the repo to `defaultRepo`. */
export function readSelector(input: unknown, defaultRepo: string): Selector {
  const o = obj(input)
  const session = noDash(optString(o, "session"), "session")
  const explicitRepo = optString(o, "repo")
  if (session) return { session }
  const repo = explicitRepo ?? defaultRepo
  if (explicitRepo !== undefined) {
    let ok = false
    try {
      ok = statSync(explicitRepo).isDirectory()
    } catch {}
    if (!ok) throw new InputError(`\`repo\` is not an existing directory: ${explicitRepo}`)
  }
  return { repo }
}

/** `<session-id>` or `--repo <path>`. */
export function selectorArgs(selector: Selector): string[] {
  if (selector.session) return [selector.session]
  if (selector.repo) return ["--repo", selector.repo]
  return []
}

function countDefined(...values: unknown[]): number {
  return values.filter((v) => v !== undefined).length
}

// ---------------------------------------------------------------- tools

export function buildSessions(): Command {
  return { args: ["session", "list", "--json"] }
}

export function buildReview(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const args = ["session", "review", ...selectorArgs(sel)]
  if (optBool(o, "includePatch")) args.push("--include-patch")
  if (optBool(o, "includeNotes")) args.push("--include-notes")
  args.push("--json")
  return { args }
}

export function buildContext(sel: Selector): Command {
  return { args: ["session", "context", ...selectorArgs(sel), "--json"] }
}

export function buildNavigate(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const file = optString(o, "file")
  const hunk = optPositiveInt(o, "hunk")
  const oldLine = optPositiveInt(o, "oldLine")
  const newLine = optPositiveInt(o, "newLine")
  const comment = noDash(optString(o, "comment"), "comment")
  const direction = optString(o, "direction")
  if (direction !== undefined && direction !== "next" && direction !== "prev") {
    throw new InputError("`direction` must be \"next\" or \"prev\".")
  }

  const lineTargets = countDefined(hunk, oldLine, newLine)
  const modes = countDefined(comment, direction, lineTargets > 0 || file !== undefined ? true : undefined)
  if (modes !== 1) {
    throw new InputError(
      "Specify exactly one navigation mode: `file` with one of `hunk`/`oldLine`/`newLine`, or `comment` (a comment id), or `direction` (\"next\"/\"prev\").",
    )
  }

  const args = ["session", "navigate", ...selectorArgs(sel)]
  if (comment !== undefined) {
    args.push("--comment", comment)
  } else if (direction !== undefined) {
    args.push(direction === "next" ? "--next-comment" : "--prev-comment")
  } else {
    if (file === undefined) throw new InputError("`file` is required when navigating to a hunk or line.")
    if (lineTargets !== 1) throw new InputError("Specify exactly one of `hunk`, `oldLine`, or `newLine`.")
    args.push("--file", file)
    if (hunk !== undefined) args.push("--hunk", String(hunk))
    if (oldLine !== undefined) args.push("--old-line", String(oldLine))
    if (newLine !== undefined) args.push("--new-line", String(newLine))
  }
  args.push("--json")
  return { args }
}

export interface CommentItem {
  filePath?: string
  hunk?: number
  oldLine?: number
  newLine?: number
  replyTo?: string
  summary: string
  rationale?: string
  author?: string
}

/** Validate one batch item and return it in the shape `comment apply --stdin` expects. */
export function normalizeCommentItem(raw: unknown, index: number): CommentItem {
  const label = `comments[${index}]`
  let o: Obj
  try {
    o = obj(raw)
  } catch {
    throw new InputError(`${label} must be an object.`)
  }
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (error) {
      throw new InputError(`${label}: ${(error as Error).message}`)
    }
  }
  const summary = wrap(() => reqString(o, "summary"))
  const rationale = wrap(() => optString(o, "rationale"))
  const author = wrap(() => optString(o, "author"))
  const replyTo = wrap(() => optString(o, "replyTo"))
  const filePath = wrap(() => optString(o, "filePath"))
  const hunk = wrap(() => optPositiveInt(o, "hunk"))
  const oldLine = wrap(() => optPositiveInt(o, "oldLine"))
  const newLine = wrap(() => optPositiveInt(o, "newLine"))
  const targets = countDefined(hunk, oldLine, newLine)

  const item: CommentItem = { summary }
  if (rationale !== undefined) item.rationale = rationale
  if (author !== undefined) item.author = author

  if (replyTo !== undefined) {
    if (filePath !== undefined || targets > 0) {
      throw new InputError(`${label}: a reply (\`replyTo\`) must not include \`filePath\`, \`hunk\`, \`oldLine\` or \`newLine\`.`)
    }
    item.replyTo = replyTo
    return item
  }
  if (filePath === undefined) throw new InputError(`${label}: provide either \`replyTo\` or \`filePath\` with exactly one of \`hunk\`, \`oldLine\`, \`newLine\`.`)
  if (targets !== 1) throw new InputError(`${label}: specify exactly one of \`hunk\`, \`oldLine\`, or \`newLine\`.`)
  item.filePath = filePath
  if (hunk !== undefined) item.hunk = hunk
  if (oldLine !== undefined) item.oldLine = oldLine
  if (newLine !== undefined) item.newLine = newLine
  return item
}

export function buildComment(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const comments = o.comments
  if (!Array.isArray(comments) || comments.length === 0) throw new InputError("`comments` must be a non-empty array.")
  const items = comments.map((c, i) => normalizeCommentItem(c, i))
  const args = ["session", "comment", "apply", ...selectorArgs(sel), "--stdin"]
  if (optBool(o, "focus")) args.push("--focus")
  args.push("--json")
  return { args, stdin: JSON.stringify({ comments: items }) }
}

export const COMMENT_TYPES = ["live", "all", "ai", "agent", "user"] as const
export type CommentType = (typeof COMMENT_TYPES)[number]

export function buildComments(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const type = optString(o, "type")
  if (type !== undefined && !(COMMENT_TYPES as readonly string[]).includes(type)) {
    throw new InputError(`\`type\` must be one of: ${COMMENT_TYPES.join(", ")}.`)
  }
  const file = optString(o, "file")
  const args = ["session", "comment", "list", ...selectorArgs(sel)]
  if (file) args.push("--file", file)
  if (type) args.push("--type", type)
  args.push("--json")
  return { args }
}

export function buildCommentRemove(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const id = noDash(reqString(o, "id"), "id")!
  // `<session-id> <comment-id>` or `<comment-id> --repo <path>`
  const args = sel.session
    ? ["session", "comment", "rm", sel.session, id, "--json"]
    : ["session", "comment", "rm", ...selectorArgs(sel), id, "--json"]
  return { args }
}

export const HIGHLIGHT_TONES = ["match", "info", "warning", "error", "dim", "current"] as const

export function buildHighlight(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const action = optString(o, "action") ?? "add"
  if (action === "clear") {
    const file = optString(o, "file")
    const args = ["session", "highlight", "clear", ...selectorArgs(sel)]
    if (file) args.push("--file", file)
    args.push("--json")
    return { args }
  }
  if (action !== "add") throw new InputError("`action` must be \"add\" or \"clear\".")

  const file = reqString(o, "file")
  const oldLine = optPositiveInt(o, "oldLine")
  const newLine = optPositiveInt(o, "newLine")
  if (countDefined(oldLine, newLine) !== 1) throw new InputError("Specify exactly one of `oldLine` or `newLine`.")
  const start = optNonNegInt(o, "start")
  const end = optNonNegInt(o, "end")
  if (start === undefined || end === undefined) throw new InputError("`start` and `end` are required for highlight add.")
  if (end <= start) throw new InputError("`end` must be greater than `start` (range is [start, end), UTF-16 offsets).")
  const tone = optString(o, "tone")
  if (tone !== undefined && !(HIGHLIGHT_TONES as readonly string[]).includes(tone)) {
    throw new InputError(`\`tone\` must be one of: ${HIGHLIGHT_TONES.join(", ")}.`)
  }

  const args = ["session", "highlight", "add", ...selectorArgs(sel), "--file", file]
  if (oldLine !== undefined) args.push("--old-line", String(oldLine))
  if (newLine !== undefined) args.push("--new-line", String(newLine))
  args.push("--start", String(start), "--end", String(end))
  if (tone) args.push("--tone", tone)
  if (optBool(o, "focus")) args.push("--focus")
  args.push("--json")
  return { args }
}

const FORBIDDEN_RELOAD_FLAGS = [
  "--extension",
  "--enable-extension",
  "--disable-extension",
  "--no-extensions",
  "--agent-context",
  "--files",
]

export function buildReload(input: unknown, sel: Selector): Command {
  const o = obj(input)
  const rest = o.args
  if (!Array.isArray(rest) || rest.length === 0 || rest.some((a) => typeof a !== "string")) {
    throw new InputError("`args` must be a non-empty array of strings, e.g. [\"diff\", \"--staged\"] or [\"show\", \"HEAD~1\"].")
  }
  const command = rest[0] as string
  if (command !== "diff" && command !== "show") {
    throw new InputError("`args[0]` must be \"diff\" or \"show\".")
  }
  for (const arg of rest as string[]) {
    const name = arg.split("=", 1)[0]!
    if (FORBIDDEN_RELOAD_FLAGS.includes(name)) throw new InputError(`\`${name}\` is not allowed in reload args.`)
    if (arg === "--") break
  }
  const source = optString(o, "source")
  const args = ["session", "reload", ...selectorArgs(sel)]
  if (source) args.push("--source", source)
  args.push("--json", "--", ...(rest as string[]))
  return { args }
}
