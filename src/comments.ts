/**
 * Pure helpers: parse `hunk session comment list --json` output and format user
 * comments into a prompt for the agent.
 *
 * Observed shapes (hunk 0.23): `{ comments: Array<LiveComment | ReviewNote> }`
 *   LiveComment: { commentId, parentId?, filePath, hunkIndex, side: "old"|"new", line, summary, rationale?, author?, createdAt }
 *   ReviewNote:  { noteId, parentId?, source: "ai"|"agent"|"user", filePath, hunkIndex?, oldRange?, newRange?, body, title?, author?, createdAt, editable }
 * The parser is tolerant: unknown/missing fields are dropped rather than rejected.
 */

export interface HunkComment {
  id: string
  parentId?: string
  source?: string
  filePath: string
  side?: "old" | "new"
  /** First line of the anchor (1-based) when known. */
  line?: number
  /** Last line of the anchor when it spans multiple lines. */
  endLine?: number
  /** 1-based hunk number when known. */
  hunk?: number
  summary: string
  rationale?: string
  author?: string
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function range(v: unknown): [number, number] | undefined {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]]
  if (isObj(v) && typeof v.start === "number" && typeof v.end === "number") return [v.start, v.end]
  return undefined
}

export function parseComment(raw: unknown): HunkComment | undefined {
  if (!isObj(raw)) return undefined
  const id = str(raw.commentId) ?? str(raw.noteId) ?? str(raw.id)
  const filePath = str(raw.filePath) ?? str(raw.file) ?? str(raw.path)
  const summary = str(raw.summary) ?? str(raw.body) ?? str(raw.title) ?? str(raw.text)
  if (!id || !filePath || summary === undefined) return undefined

  const comment: HunkComment = { id, filePath, summary }
  const parentId = str(raw.parentId)
  if (parentId) comment.parentId = parentId
  const source = str(raw.source)
  if (source) comment.source = source
  const rationale = str(raw.rationale)
  if (rationale) comment.rationale = rationale
  const author = str(raw.author)
  if (author) comment.author = author

  const hunkIndex = int(raw.hunkIndex)
  if (hunkIndex !== undefined) comment.hunk = hunkIndex + 1

  const side = raw.side === "old" || raw.side === "new" ? raw.side : undefined
  const line = int(raw.line)
  if (side && line !== undefined) {
    comment.side = side
    comment.line = line
  } else {
    const newRange = range(raw.newRange)
    const oldRange = range(raw.oldRange)
    const picked = newRange ? ([newRange, "new"] as const) : oldRange ? ([oldRange, "old"] as const) : undefined
    if (picked) {
      comment.side = picked[1]
      comment.line = picked[0][0]
      if (picked[0][1] !== picked[0][0]) comment.endLine = picked[0][1]
    }
  }
  // A note whose title is separate from its body: keep title as the summary prefix.
  const title = str(raw.title)
  if (title && str(raw.body) && title !== comment.summary) comment.summary = `${title}: ${comment.summary}`
  return comment
}

/** Accepts the raw CLI JSON (`{comments: [...]}`) or a bare array. */
export function parseCommentList(json: unknown): HunkComment[] {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.comments) ? json.comments : []
  const out: HunkComment[] = []
  for (const item of list) {
    const parsed = parseComment(item)
    if (parsed) out.push(parsed)
  }
  return out
}

export function formatLocation(c: HunkComment): string {
  if (c.line === undefined) return c.hunk !== undefined ? `${c.filePath} (hunk ${c.hunk})` : c.filePath
  const end = c.endLine !== undefined ? `-${c.endLine}` : ""
  return `${c.filePath}:${c.line}${end} (${c.side === "old" ? "old side / removed line" : "new side"})`
}

/** Build the prompt sent to the agent for a set of user review comments. */
export function formatCommentsPrompt(comments: readonly HunkComment[]): string {
  const lines: string[] = []
  const noun = comments.length === 1 ? "comment" : "comments"
  lines.push(`I left ${comments.length} review ${noun} in Hunk. Please address each one: make the requested change or explain why not.`)
  lines.push("")
  comments.forEach((c, i) => {
    lines.push(`${i + 1}. ${formatLocation(c)}`)
    lines.push(`   comment id: ${c.id}`)
    lines.push(`   ${c.summary.replace(/\n/g, "\n   ")}`)
    if (c.rationale) lines.push(`   rationale: ${c.rationale.replace(/\n/g, "\n   ")}`)
    if (c.parentId) lines.push(`   (reply to ${c.parentId})`)
    lines.push("")
  })
  lines.push(
    "You may reply to a comment in the live Hunk session with the `hunk_comment` tool (use `replyTo` with the comment id). " +
      "Do not launch the Hunk TUI yourself.",
  )
  return lines.join("\n")
}

/** Keep only human-authored comments (defensive: `--type user` should already do this). */
export function onlyUser(comments: readonly HunkComment[]): HunkComment[] {
  return comments.filter((c) => c.source === undefined || c.source === "user")
}
