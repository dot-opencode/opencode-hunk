import { realpathSync } from "node:fs"
import { samePath } from "./ghostty.ts"
import type { HunkComment } from "./comments.ts"
import { newestSession, type ListedSession } from "./hunk.ts"

export interface WatchDeps {
  /** Live sessions, or undefined when the query failed (unknown state — the tick is skipped). */
  listSessions: () => Promise<ListedSession[] | undefined>
  /** Current user comments of one live session. */
  fetchComments: (sessionId: string) => Promise<HunkComment[]>
}

export interface WatchOptions {
  repo: string
  /** Session ids that existed before the viewer was opened; never adopted as "the" session. */
  ignoreSessionIds?: ReadonlySet<string>
  pollMs: number
  /** How long to wait for the session to appear. */
  startTimeoutMs: number
  signal: AbortSignal
  /** The session never showed up. */
  onTimeout: () => void
  /** The session went away. Receives the latest non-empty user comments seen (possibly empty). */
  onClosed: (cached: HunkComment[]) => void | Promise<void>
}

export function sessionMatchesRepo(session: ListedSession, repo: string): boolean {
  return samePath(session.repoRoot, repo) || samePath(session.cwd, repo)
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })

/**
 * Wait for a hunk session on `repo` to appear, cache its latest non-empty user comments while it is live,
 * and report when it disappears. Resolves when finished or aborted; never throws.
 */
export async function watchRepo(deps: WatchDeps, options: WatchOptions): Promise<void> {
  const { signal } = options
  const started = Date.now()
  let sessionId: string | undefined
  let cached: HunkComment[] = []

  while (!signal.aborted) {
    let sessions: ListedSession[] | undefined
    try {
      sessions = await deps.listSessions()
    } catch {
      sessions = undefined
    }
    if (signal.aborted) return

    if (sessions) {
      if (!sessionId) {
        const found = newestSession(
          sessions.filter((s) => sessionMatchesRepo(s, options.repo) && !options.ignoreSessionIds?.has(s.sessionId)),
        )
        if (found) sessionId = found.sessionId
        else if (Date.now() - started >= options.startTimeoutMs) return void options.onTimeout()
      } else if (!sessions.some((s) => s.sessionId === sessionId)) {
        return void (await options.onClosed(cached))
      }
    } else if (!sessionId && Date.now() - started >= options.startTimeoutMs) {
      return void options.onTimeout()
    }

    if (sessionId && sessions?.some((s) => s.sessionId === sessionId)) {
      try {
        const comments = await deps.fetchComments(sessionId)
        cached = comments
      } catch {}
    }
    await sleep(options.pollMs, signal)
  }
}

/** One active watcher per repo; `stopAll` aborts everything (plugin cleanup). */
export class WatchRegistry {
  private readonly active = new Map<string, AbortController>()

  private key(repo: string): string {
    try {
      return realpathSync.native(repo)
    } catch {
      return repo
    }
  }

  has(repo: string): boolean {
    return this.active.has(this.key(repo))
  }

  /** Starts `run` unless a watcher for `repo` already exists. Returns false when one was already running. */
  start(rawRepo: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    const repo = this.key(rawRepo)
    if (this.active.has(repo)) return false
    const controller = new AbortController()
    this.active.set(repo, controller)
    void run(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (this.active.get(repo) === controller) this.active.delete(repo)
      })
    return true
  }

  stopAll(): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }
}
