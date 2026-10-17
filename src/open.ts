import { splitArgs } from "./hunk.ts"

export type Mode = "auto" | "suspend" | "tmux" | "ghostty"
export type ResolvedMode = "suspend" | "tmux" | "ghostty"
export type Split = "-h" | "-v"

export interface TuiConfig {
  bin: string
  mode: Mode
  tmuxSplit: Split
  pollMs: number
}

export function readTuiConfig(options: Readonly<Record<string, any>> | undefined): TuiConfig {
  const o = options ?? {}
  const mode: Mode = o.mode === "suspend" || o.mode === "tmux" || o.mode === "ghostty" || o.mode === "auto" ? o.mode : "auto"
  const tmuxSplit: Split = o.tmuxSplit === "-v" ? "-v" : "-h"
  const bin = typeof o.bin === "string" && o.bin.trim() ? o.bin : "hunk"
  const pollMs = typeof o.pollMs === "number" && o.pollMs >= 250 ? o.pollMs : 2000
  return { bin, mode, tmuxSplit, pollMs }
}

/** auto: tmux when $TMUX is set, else ghostty on macOS inside Ghostty, else suspend. */
export function resolveMode(
  mode: Mode,
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): ResolvedMode {
  if (mode !== "auto") return mode
  if (env.TMUX) return "tmux"
  if (platform === "darwin" && env.TERM_PROGRAM === "ghostty") return "ghostty"
  return "suspend"
}

/** `/hunk --staged` → ["diff","--staged"]; `/hunk show HEAD~1` → ["show","HEAD~1"]. */
export function parseOpenInput(input: string | undefined): string[] {
  const args = splitArgs(input)
  const cmd = args[0] === "show" || args[0] === "diff" ? args : ["diff", ...args]
  // Agent replies are hidden by default in hunk; show them unless the user opted out.
  if (!cmd.includes("--agent-notes") && !cmd.includes("--no-agent-notes")) {
    const sep = cmd.indexOf("--")
    if (sep === -1) cmd.push("--agent-notes")
    else cmd.splice(sep, 0, "--agent-notes")
  }
  return cmd
}

export function buildTmuxArgs(split: Split, cwd: string, bin: string, hunkArgs: readonly string[]): string[] {
  return ["split-window", split, "-c", cwd, bin, ...hunkArgs]
}

export function buildListUserCommentsArgs(repo: string): string[] {
  return ["session", "comment", "list", "--repo", repo, "--type", "user", "--json"]
}
