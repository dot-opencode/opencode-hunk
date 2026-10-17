import { spawn } from "node:child_process"

export interface RunOptions {
  /** Hunk binary (default "hunk"). */
  bin?: string
  cwd?: string
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Delay between SIGTERM and SIGKILL when the child ignores SIGTERM (default 2000). */
  killGraceMs?: number
}

export interface RunResult {
  stdout: string
  stderr: string
  /** Exit code; null when killed by a signal / timeout; -1 when the process could not be spawned. */
  code: number | null
  /** Set when the process could not be spawned (e.g. ENOENT) or timed out. */
  failure?: "not-found" | "spawn" | "timeout" | "aborted"
  failureMessage?: string
}

export const DEFAULT_BIN = "hunk"
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_KILL_GRACE_MS = 2_000
/** After SIGKILL, how long to wait for the pipes to close before settling anyway (orphaned grandchildren may hold them). */
const POST_KILL_SETTLE_MS = 500

/** Error that is safe to show to the model / user as-is. */
export class HunkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HunkError"
  }
}

/** Run `<bin> ...args` and collect its output. Never rejects: failures are reported in the result. */
export function runHunk(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const bin = options.bin || DEFAULT_BIN
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  return new Promise<RunResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let failure: RunResult["failure"]
    let failureMessage: string | undefined

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (settleTimer) clearTimeout(settleTimer)
      options.signal?.removeEventListener("abort", onAbort)
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      resolve({ stdout, stderr, code, failure, failureMessage })
    }

    if (options.signal?.aborted) {
      resolve({ stdout, stderr, code: null, failure: "aborted", failureMessage: "Aborted" })
      return
    }

    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(bin, [...args], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      })
    } catch (error) {
      resolve({ stdout, stderr, code: -1, failure: "spawn", failureMessage: String(error) })
      return
    }

    const terminate = () => {
      if (killTimer || settled) return
      child!.kill("SIGTERM")
      killTimer = setTimeout(() => {
        child!.kill("SIGKILL")
        // The pipes may stay open (orphaned grandchildren), so do not wait for "close" forever.
        settleTimer = setTimeout(() => finish(null), POST_KILL_SETTLE_MS)
      }, graceMs)
    }
    const onAbort = () => {
      failure = "aborted"
      failureMessage = "Aborted"
      terminate()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        failure = "timeout"
        failureMessage = `Timed out after ${timeoutMs}ms`
        terminate()
      }, timeoutMs)
    }

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => (stdout += chunk))
    child.stderr?.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = error.code === "ENOENT" ? "not-found" : "spawn"
      failureMessage = error.message
      finish(-1)
    })
    child.on("close", (code) => finish(code))

    // Ignore EPIPE if the child exits before reading stdin.
    child.stdin?.on("error", () => {})
    if (options.stdin !== undefined) child.stdin?.write(options.stdin)
    child.stdin?.end()
  })
}

/** Best-effort JSON parse; returns undefined on failure. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export const NO_SESSION_HINT =
  "No active Hunk session — ask the user to run /hunk in OpenCode (or `hunk diff` in a terminal for this repository) and try again. Do not launch the Hunk TUI yourself."
export const NO_SESSION_HINT_USER = "No active Hunk session. Run /hunk (or `hunk diff` in a terminal for this repository) first."

export type Audience = "user" | "model"

/** True for hunk errors that mean "no live session matched the selector". */
export function isNoSessionMessage(message: string): boolean {
  return /No active Hunk sessions|No active session matches|protocol-validation-failed/i.test(message)
}

export interface ListedSession {
  sessionId: string
  repoRoot?: string
  cwd?: string
  title?: string
  sourceLabel?: string
  fileCount?: number
  launchedAt?: string
}

/** Parse `hunk session list --json` (`{sessions: [...]}`) tolerantly. */
export function parseSessionList(json: unknown): ListedSession[] {
  const list =
    Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as any).sessions) ? (json as any).sessions : []
  const out: ListedSession[] = []
  for (const s of list) {
    if (!s || typeof s !== "object" || typeof s.sessionId !== "string") continue
    out.push({
      sessionId: s.sessionId,
      repoRoot: typeof s.repoRoot === "string" ? s.repoRoot : undefined,
      cwd: typeof s.cwd === "string" ? s.cwd : undefined,
      title: typeof s.title === "string" ? s.title : undefined,
      sourceLabel: typeof s.sourceLabel === "string" ? s.sourceLabel : undefined,
      fileCount: typeof s.fileCount === "number" ? s.fileCount : undefined,
      launchedAt: typeof s.launchedAt === "string" ? s.launchedAt : undefined,
    })
  }
  return out
}

/** Newest session by launchedAt (sessions without a parsable date sort oldest). */
export function newestSession(sessions: readonly ListedSession[]): ListedSession | undefined {
  const time = (s: ListedSession) => {
    const t = s.launchedAt ? Date.parse(s.launchedAt) : NaN
    return Number.isNaN(t) ? -Infinity : t
  }
  let best: ListedSession | undefined
  for (const s of sessions) if (!best || time(s) >= time(best)) best = s
  return best
}

/** Message for a no-session style failure, given the daemon's actual live sessions. */
export function noSessionMessage(sessions: readonly ListedSession[], target: string | undefined, sessionId?: string): string {
  if (sessions.length === 0) return sessionId ? `${NO_SESSION_HINT}\n(Requested session: ${sessionId})` : NO_SESSION_HINT
  const lines = sessions.map((s) => `- ${s.sessionId}  repo: ${s.repoRoot ?? s.cwd ?? "?"}${s.title ? `  (${s.title})` : ""}`)
  const what = sessionId ? `session ${sessionId}` : target ? `repo ${target}` : "the requested target"
  return (
    `No live Hunk session matches ${what}. Live sessions:\n${lines.join("\n")}\n` +
    "Retry with `session` set to one of these ids (or `repo` set to its repo root), or ask the user to run /hunk for this repository."
  )
}

/** Turn a failed run into an actionable message. Returns undefined when the run succeeded. */
export function describeFailure(result: RunResult, bin = DEFAULT_BIN, audience: Audience = "model"): string | undefined {
  const forUser = audience === "user"
  if (result.failure === "not-found") {
    return `Could not find the \`${bin}\` binary. Install Hunk (https://github.com/modem-dev/hunk) or set the plugin option \`bin\`.`
  }
  if (result.failure === "timeout" || result.failure === "aborted" || result.failure === "spawn") {
    return `hunk failed: ${result.failureMessage ?? result.failure}`
  }
  if (result.code === 0) return undefined

  const raw = (result.stderr.trim() || result.stdout.trim() || `hunk exited with code ${result.code}`).trim()
  const parsed = tryParseJson(result.stderr) ?? tryParseJson(result.stdout)
  let message = raw
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>
    const text = obj.error ?? obj.message
    if (typeof text === "string") message = text
    if (obj.recommendedAction) message += ` (recommendedAction: ${String(obj.recommendedAction)})`
  }
  if (/Unknown command:\s*session\b/i.test(message)) {
    return "This Hunk version has no `session` command: hunk >= 0.23 required. Upgrade Hunk."
  }
  if (/protocol-validation-failed/i.test(message)) {
    // hunk emits this opaque error when the daemon has no session matching the selector.
    return forUser
      ? `No live Hunk session matches this repository.\n${NO_SESSION_HINT_USER}`
      : `No live Hunk session matches the requested repo/session (hunk: protocol-validation-failed).\n${NO_SESSION_HINT}`
  }
  if (isNoSessionMessage(message)) {
    return `${message}\n${forUser ? NO_SESSION_HINT_USER : NO_SESSION_HINT}`
  }
  if (/daemon/i.test(message) && /build|newer|mismatch/i.test(message)) {
    return forUser
      ? `${message}\nRestart the daemon with \`hunk daemon restart --yes\`.`
      : `${message}\nAsk the user before running \`hunk daemon restart --yes\`; never restart it unprompted.`
  }
  return message
}

/** Git toplevel of a directory, or undefined when it is not inside a git repo. */
export async function findGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    try {
      const child = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"], signal })
      let out = ""
      child.stdout?.setEncoding("utf8")
      child.stdout?.on("data", (chunk: string) => (out += chunk))
      child.on("error", () => resolve(undefined))
      child.on("close", (code) => resolve(code === 0 ? out.trim() || undefined : undefined))
    } catch {
      resolve(undefined)
    }
  })
}

/** Resolve the git toplevel for a directory (hunk matches sessions by repo root); falls back to the directory. */
export async function resolveRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return (await findGitRoot(cwd, signal)) ?? cwd
}

/** Split a shell-like argument string ("--staged 'a b' main...HEAD") into args. */
export function splitArgs(input: string | undefined): string[] {
  if (!input) return []
  const args: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let has = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) current += input[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current)
      current = ""
      has = false
    } else {
      current += ch
      has = true
    }
  }
  if (has || current) args.push(current)
  return args
}
