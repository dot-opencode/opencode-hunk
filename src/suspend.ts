import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import type { HunkComment } from "./comments.ts"

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface SuspendedOptions {
  renderer: { suspend(): void; resume(): void }
  bin: string
  args: readonly string[]
  cwd: string
  pollMs: number
  /** Successful fetch of the current user comments (may be empty); undefined/throw = unknown, ignored. */
  fetchComments: () => Promise<HunkComment[] | undefined>
  spawn?: SpawnFn
}

export interface SuspendedResult {
  /** Latest comments seen while hunk was running (hunk drops them when the window closes). */
  comments: HunkComment[]
  /** Exit code of hunk; null when killed by a signal. */
  code: number | null
}

/** Run hunk in the foreground (TUI suspended) while caching user comments. Rejects only on spawn errors. */
export async function runSuspended(options: SuspendedOptions): Promise<SuspendedResult> {
  const spawnFn = options.spawn ?? (nodeSpawn as SpawnFn)
  let cached: HunkComment[] = []
  let polling = false
  let timer: ReturnType<typeof setInterval> | undefined
  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const comments = await options.fetchComments()
      if (comments) cached = comments
    } catch {
    } finally {
      polling = false
    }
  }

  options.renderer.suspend()
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawnFn(options.bin, options.args, { cwd: options.cwd, stdio: "inherit" })
      child.on("error", reject)
      child.on("close", (c) => resolve(c))
      timer = setInterval(() => void poll(), options.pollMs)
    })
    return { comments: cached, code }
  } finally {
    if (timer) clearInterval(timer)
    options.renderer.resume()
  }
}

/** Run `tmux ...args`, capturing stderr for the error message. */
export async function runTmux(args: readonly string[], spawnFn: SpawnFn = nodeSpawn as SpawnFn): Promise<void> {
  const child = spawnFn("tmux", args, { stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => (stderr += chunk))
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tmux exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
    })
  })
}
