import { accessSync, constants, realpathSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { spawn } from "node:child_process"

/** Escape a string for use inside an AppleScript double-quoted literal. */
export function appleScriptString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
  return `"${escaped}"`
}

/** POSIX-shell-safe single-quoting of one argument. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function buildCommandText(bin: string, args: readonly string[]): string {
  return [bin, ...args].map(shellQuote).join(" ")
}

/** Resolve a binary name to an absolute path via PATH (like `which`); returns the input when not found. */
export function resolveBinPath(bin: string, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const isExecutable = (p: string) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (bin.includes("/")) return isAbsolute(bin) ? bin : resolve(cwd, bin)
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (isExecutable(candidate)) return candidate
  }
  return bin
}

export interface GhosttyTabOptions {
  cwd: string
  /** Absolute binary path (use `resolveBinPath`). */
  bin: string
  args: readonly string[]
  /** PATH to propagate into the new tab; omitted when undefined. */
  path?: string
}

/**
 * AppleScript opening a new tab in the front window (or a new window when none exists).
 * Uses a record literal for `surface configuration`; `wait after command` is false so the tab closes when hunk quits.
 */
export function buildGhosttyScript(options: GhosttyTabOptions): string {
  const fields = [
    `initial working directory:${appleScriptString(options.cwd)}`,
    `command:${appleScriptString(buildCommandText(options.bin, options.args))}`,
    "wait after command:false",
  ]
  if (options.path) fields.push(`environment variables:{${appleScriptString(`PATH=${options.path}`)}}`)
  const config = `{${fields.join(", ")}}`
  return [
    'tell application "Ghostty"',
    "  activate",
    "  if (count of windows) is 0 then",
    `    new window with configuration ${config}`,
    "  else",
    `    new tab in front window with configuration ${config}`,
    "  end if",
    "end tell",
  ].join("\n")
}

/** Open hunk in a new Ghostty tab via osascript (script passed on stdin; nothing goes through a shell). */
export function openGhosttyTab(options: GhosttyTabOptions): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolvePromise) => {
    let stderr = ""
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("osascript", ["-"], { stdio: ["pipe", "ignore", "pipe"] })
    } catch (error) {
      resolvePromise({ ok: false, message: String(error) })
      return
    }
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (error) => resolvePromise({ ok: false, message: error.message }))
    child.on("close", (code) => {
      if (code === 0) return resolvePromise({ ok: true })
      resolvePromise({ ok: false, message: describeOsascriptError(stderr) })
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(buildGhosttyScript(options))
  })
}

export function describeOsascriptError(stderr: string): string {
  const text = stderr.trim()
  if (/-1743/.test(text)) {
    return "macOS blocked automation of Ghostty (-1743). Allow your terminal to control Ghostty in System Settings → Privacy & Security → Automation."
  }
  return text || "osascript failed"
}

/** Compare paths by realpath when possible (macOS /tmp and /var symlinks). */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string) => {
    try {
      return realpathSync.native(p)
    } catch {
      return resolve(p)
    }
  }
  return norm(a) === norm(b)
}
