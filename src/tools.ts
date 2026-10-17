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
  type Command,
  type Selector,
} from "./args.ts"
import {
  describeFailure,
  isNoSessionMessage,
  noSessionMessage,
  parseSessionList,
  runHunk,
  tryParseJson,
  type RunResult,
} from "./hunk.ts"
import { sessionMatchesRepo } from "./watch.ts"

export const NAMESPACE = "hunk"
export const NAMESPACE_DESCRIPTION =
  "Inspect and control a live Hunk diff-review session (the interactive terminal diff viewer the user has open). " +
  "The Hunk TUI belongs to the user: NEVER launch `hunk diff`/`hunk show` yourself. " +
  "If there is no live session, ask the user to run /hunk in OpenCode (or `hunk diff` in a terminal)."

const COMMON =
  " The Hunk TUI is for the user; never launch it yourself. If no live session exists, ask the user to run /hunk."

const targetProps = {
  repo: {
    type: "string",
    description: "Repository root of the live Hunk session to target. Defaults to the current working directory.",
  },
  session: {
    type: "string",
    description: "Exact Hunk session id (from hunk_sessions). Use when several sessions share a repo; overrides `repo`.",
  },
} as const

type JsonSchema = Record<string, unknown>

export interface ToolSpec {
  name: string
  description: string
  schema: JsonSchema
  /** Whether the tool takes `repo`/`session` (hunk_sessions lists all sessions and does not). */
  targeted: boolean
  /** OpenCode permission key checked before the tool runs (mutating tools only). */
  permission?: string
  build: (input: unknown, selector: Selector) => Command
}

function schema(properties: Record<string, unknown>, required: string[] = [], targeted = true): JsonSchema {
  return {
    type: "object",
    properties: targeted ? { ...properties, ...targetProps } : properties,
    required,
    additionalProperties: false,
  }
}

const commentItemSchema = {
  type: "object",
  description:
    "One note. Either a reply (`replyTo` only) or a root note: `filePath` plus exactly one of `hunk`, `oldLine`, `newLine`.",
  properties: {
    filePath: { type: "string", description: "Path of the file in the diff." },
    hunk: { type: "integer", minimum: 1, description: "1-based hunk number." },
    oldLine: { type: "integer", minimum: 1, description: "1-based line on the old (removed) side." },
    newLine: { type: "integer", minimum: 1, description: "1-based line on the new (added) side." },
    replyTo: { type: "string", description: "Id of an existing comment to reply to (e.g. \"user:123\")." },
    summary: { type: "string", description: "The note text shown inline." },
    rationale: { type: "string", description: "Optional longer explanation." },
    author: { type: "string", description: "Optional author label." },
  },
  required: ["summary"],
  additionalProperties: false,
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "sessions",
    description: "List live Hunk review sessions (ids, repo roots, what is being reviewed)." + COMMON,
    schema: schema({}, [], false),
    targeted: false,
    build: () => buildSessions(),
  },
  {
    name: "review",
    description:
      "Show the file/hunk structure of the live Hunk review (cheap). Set includePatch only when you need raw diff text; includeNotes to also return live notes." +
      COMMON,
    schema: schema({
      includePatch: { type: "boolean", description: "Include raw unified diff text per file." },
      includeNotes: { type: "boolean", description: "Include live review notes." },
    }),
    targeted: true,
    build: buildReview,
  },
  {
    name: "context",
    description: "Show the user's current focus in Hunk (selected file, hunk, line) and session state." + COMMON,
    schema: schema({}),
    targeted: true,
    build: (_input, sel) => buildContext(sel),
  },
  {
    name: "navigate",
    description:
      "Move the user's Hunk viewport. Exactly one mode: (a) `file` + exactly one of `hunk`/`oldLine`/`newLine`; (b) `comment` id; (c) `direction` next/prev comment." +
      COMMON,
    schema: schema({
      file: { type: "string", description: "Diff file path (for hunk/line navigation)." },
      hunk: { type: "integer", minimum: 1, description: "1-based hunk number." },
      oldLine: { type: "integer", minimum: 1, description: "1-based old-side line." },
      newLine: { type: "integer", minimum: 1, description: "1-based new-side line." },
      comment: { type: "string", description: "Comment id to jump to." },
      direction: { type: "string", enum: ["next", "prev"], description: "Jump to the next/previous annotated hunk." },
    }),
    targeted: true,
    build: buildNavigate,
  },
  {
    name: "comment",
    description:
      "Add inline review notes (batch) to the live Hunk session, or reply to existing comments with `replyTo`. The whole batch is validated before anything is applied." +
      COMMON,
    schema: schema(
      {
        comments: { type: "array", minItems: 1, items: commentItemSchema, description: "Notes to add." },
        focus: { type: "boolean", description: "Jump the viewport to the first note. Use sparingly." },
      },
      ["comments"],
    ),
    targeted: true,
    build: buildComment,
  },
  {
    name: "comments",
    description:
      "List review comments in the live session. type: `user` = notes the user wrote (most useful), `agent`/`ai` = agent notes, `live` (default) = legacy live agent comments, `all`." +
      COMMON,
    schema: schema({
      type: { type: "string", enum: ["live", "all", "ai", "agent", "user"], description: "Which comments to list." },
      file: { type: "string", description: "Only comments on this file." },
    }),
    targeted: true,
    build: buildComments,
  },
  {
    name: "comment_remove",
    description: "Remove one comment by id (see hunk_comments)." + COMMON,
    schema: schema({ id: { type: "string", description: "Comment id." } }, ["id"]),
    targeted: true,
    permission: "hunk_comment_remove",
    build: buildCommentRemove,
  },
  {
    name: "highlight",
    description:
      "Paint (action=add) or clear (action=clear) attention marks on a character range of a diff line, to point at the exact expression you are explaining. `start` is 0-based inclusive, `end` exclusive (UTF-16 offsets)." +
      COMMON,
    schema: schema(
      {
        action: { type: "string", enum: ["add", "clear"], description: "Defaults to add." },
        file: { type: "string", description: "Diff file path (required for add; optional filter for clear)." },
        oldLine: { type: "integer", minimum: 1 },
        newLine: { type: "integer", minimum: 1 },
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 1 },
        tone: { type: "string", enum: ["match", "info", "warning", "error", "dim", "current"] },
        focus: { type: "boolean", description: "Also land the viewport on the marked line." },
      },
      [],
    ),
    targeted: true,
    build: buildHighlight,
  },
  {
    name: "reload",
    description:
      "Swap the contents of the live Hunk session. `args` is the Hunk review command, e.g. [\"diff\"], [\"diff\",\"--staged\"], [\"diff\",\"main...HEAD\",\"--\",\"src\"], [\"show\",\"HEAD~1\"]." +
      COMMON,
    schema: schema(
      {
        args: { type: "array", minItems: 1, items: { type: "string" }, description: "Hunk command, starting with diff or show." },
        source: { type: "string", description: "Advanced: directory to run the replacement command in." },
      },
      ["args"],
    ),
    targeted: true,
    permission: "hunk_reload",
    build: buildReload,
  },
]

export interface ToolRuntime {
  bin?: string
  /** Default repo (ctx.location.directory). */
  directory: string
  timeoutMs?: number
}

/** Format a run result as tool text; throws nothing. */
export function formatResult(result: RunResult, bin?: string): string {
  const failure = describeFailure(result, bin, "model")
  if (failure) return `Error: ${failure}`
  const parsed = tryParseJson(result.stdout)
  if (parsed !== undefined) return JSON.stringify(parsed, null, 2)
  return result.stdout.trim() || result.stderr.trim() || "OK"
}

/** hunk_sessions output: only the fields the model needs. */
export function projectSessions(stdout: string): string | undefined {
  const parsed = tryParseJson(stdout)
  if (parsed === undefined) return undefined
  const sessions = parseSessionList(parsed).map((s) => ({
    sessionId: s.sessionId,
    repoRoot: s.repoRoot,
    cwd: s.cwd,
    title: s.title,
    sourceLabel: s.sourceLabel,
    fileCount: s.fileCount,
    launchedAt: s.launchedAt,
  }))
  return JSON.stringify({ sessions }, null, 2)
}

/** Validate input, run hunk, return text for the model. Never throws for expected failures. */
export async function executeTool(
  spec: ToolSpec,
  input: unknown,
  runtime: ToolRuntime,
  signal?: AbortSignal,
  run: typeof runHunk = runHunk,
): Promise<string> {
  let command: Command
  let selector: Selector = {}
  const cwd = runtime.directory
  try {
    selector = spec.targeted ? readSelector(input ?? {}, runtime.directory) : {}
    command = spec.build(input ?? {}, selector)
  } catch (error) {
    if (error instanceof InputError) return `Error: ${error.message}`
    throw error
  }
  const result = await run(command.args, {
    bin: runtime.bin,
    cwd,
    stdin: command.stdin,
    signal,
    timeoutMs: runtime.timeoutMs,
  })
  const failure = describeFailure(result, runtime.bin, "model")
  if (failure && spec.targeted && isNoSessionMessage(`${result.stderr}\n${result.stdout}`)) {
    // hunk's own error is opaque (e.g. "protocol-validation-failed"): look at what the daemon really has.
    const listed = await run(["session", "list", "--json"], { bin: runtime.bin, cwd, signal, timeoutMs: runtime.timeoutMs })
    if (listed.code === 0) {
      const sessions = parseSessionList(tryParseJson(listed.stdout))
      if (!selector.session && selector.repo) {
        const matching = sessions.filter((s) => sessionMatchesRepo(s, selector.repo!))
        if (matching.length > 1) {
          return `Error: Ambiguous: ${matching.length} sessions match this repo; pass \`session\`. Candidates:\n${matching
            .map((s) => `- ${s.sessionId}${s.title ? `  (${s.title})` : ""}`)
            .join("\n")}`
        }
      }
      return `Error: ${noSessionMessage(sessions, selector.repo, selector.session)}`
    }
  }
  if (!failure && spec.name === "sessions") {
    const projected = projectSessions(result.stdout)
    if (projected) return projected
  }
  return formatResult(result, runtime.bin)
}
