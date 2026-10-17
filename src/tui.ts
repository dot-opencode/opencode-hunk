import { Plugin } from "@opencode/plugin/tui"
import { formatCommentsPrompt, onlyUser, parseCommentList, type HunkComment } from "./comments.ts"
import { openGhosttyTab, resolveBinPath } from "./ghostty.ts"
import { describeFailure, findGitRoot, newestSession, parseSessionList, resolveRepoRoot, runHunk, tryParseJson, type ListedSession } from "./hunk.ts"
import { buildListUserCommentsArgs, buildTmuxArgs, parseOpenInput, readTuiConfig, resolveMode, type TuiConfig } from "./open.ts"
import { runSuspended, runTmux } from "./suspend.ts"
import { WatchRegistry, sessionMatchesRepo, watchRepo } from "./watch.ts"

type Context = Plugin.Context

const SESSION_START_TIMEOUT_MS = 30_000

function currentSessionID(context: Context): string | undefined {
  try {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  } catch {
    return undefined
  }
}

function sessionDirectory(context: Context, sessionID: string | undefined): string | undefined {
  if (sessionID) {
    try {
      const dir = context.data.session.get(sessionID)?.location?.directory
      if (dir) return dir
    } catch {}
  }
  return undefined
}

function resolveCwd(context: Context, sessionID: string | undefined): string {
  return sessionDirectory(context, sessionID) ?? context.location?.directory ?? context.data.location.default().directory
}

const plural = (n: number) => `${n} hunk comment${n === 1 ? "" : "s"}`

/** Live sessions, or undefined when the query failed. "No active sessions" counts as an empty list. */
async function listLiveSessions(config: TuiConfig, cwd: string, signal?: AbortSignal): Promise<ListedSession[] | undefined> {
  const result = await runHunk(["session", "list", "--json"], { bin: config.bin, cwd, timeoutMs: 10_000, signal })
  if (result.code === 0) return parseSessionList(tryParseJson(result.stdout))
  return /No active Hunk sessions/i.test(result.stderr + result.stdout) ? [] : undefined
}

/**
 * User comments of the live session: the exact session id when given, else the newest session matching the repo
 * (`--repo` fails with protocol-validation-failed when several sessions match).
 */
async function fetchUserComments(config: TuiConfig, repo: string, sessionId?: string): Promise<{ comments: HunkComment[]; error?: string }> {
  let id = sessionId
  if (!id) {
    const sessions = await listLiveSessions(config, repo)
    id = newestSession((sessions ?? []).filter((s) => sessionMatchesRepo(s, repo)))?.sessionId
  }
  const args = id ? ["session", "comment", "list", id, "--type", "user", "--json"] : buildListUserCommentsArgs(repo)
  const result = await runHunk(args, { bin: config.bin, cwd: repo, timeoutMs: 10_000 })
  const failure = describeFailure(result, config.bin, "user")
  if (failure) return { comments: [], error: failure }
  return { comments: onlyUser(parseCommentList(tryParseJson(result.stdout))) }
}

async function sendComments(context: Context, sessionID: string, comments: HunkComment[]): Promise<void> {
  await context.client.session.prompt({ sessionID, text: formatCommentsPrompt(comments) })
  context.ui.toast.show({ message: `Sent ${plural(comments.length)} to the agent`, variant: "success" })
}

/** Shared tail of every "hunk closed" flow: confirm, then send to the OpenCode session. */
async function offerToSend(context: Context, sessionID: string | undefined, comments: HunkComment[]): Promise<void> {
  if (comments.length === 0) return
  if (!sessionID) {
    context.ui.toast.show({ message: `Hunk had ${plural(comments.length)} but no session is open to send them to`, variant: "warning" })
    return
  }
  const ok = await context.ui.dialog.confirm({
    title: "Hunk comments",
    message: `Send ${plural(comments.length)} to the agent?`,
    label: { confirm: "Send", cancel: "Discard" },
  })
  if (!ok) return
  try {
    await sendComments(context, sessionID, comments)
  } catch (error) {
    context.ui.toast.show({ title: "Hunk", message: error instanceof Error ? error.message : String(error), variant: "error" })
  }
}

export default Plugin.define({
  id: "hunk.cli",
  setup(context) {
    const config = readTuiConfig(context.options)
    const watchers = new WatchRegistry()

    /** Background feedback loop for modes where hunk runs outside this process (ghostty tab). */
    const watchInBackground = (repo: string, sessionID: string | undefined, ignoreSessionIds: ReadonlySet<string>) => {
      const started = watchers.start(repo, (signal) =>
        watchRepo(
          {
            listSessions: () => listLiveSessions(config, repo, signal),
            fetchComments: async (id) => (await fetchUserComments(config, repo, id)).comments,
          },
          {
            repo,
            ignoreSessionIds,
            pollMs: config.pollMs,
            startTimeoutMs: SESSION_START_TIMEOUT_MS,
            signal,
            onTimeout: () =>
              context.ui.toast.show({ message: "Hunk session did not appear within 30s; no longer watching for comments.", variant: "warning" }),
            onClosed: (cached) => offerToSend(context, sessionID, cached),
          },
        ),
      )
      if (!started) {
        context.ui.toast.show({ message: "Already watching Hunk for this repo", variant: "info" })
      }
    }

    /** Git toplevel of `cwd`, or undefined after showing a toast when it is not a git repository. */
    const requireGitRepo = async (cwd: string): Promise<string | undefined> => {
      const root = await findGitRoot(cwd)
      if (!root) {
        context.ui.toast.show({ title: "Hunk", message: `${cwd} is not a git repository; hunk needs one to review.`, variant: "error" })
      }
      return root
    }

    const open = async (input?: string) => {
      const sessionID = currentSessionID(context)
      const cwd = resolveCwd(context, sessionID)
      const hunkArgs = parseOpenInput(input)
      const mode = resolveMode(config.mode, process.env)

      try {
        if (mode === "tmux") {
          if (!(await requireGitRepo(cwd))) return
          await runTmux(buildTmuxArgs(config.tmuxSplit, cwd, resolveBinPath(config.bin), hunkArgs))
          context.ui.toast.show({
            message: "Hunk opened in a tmux split. Run /hunk-send to send your comments to the agent.",
            variant: "info",
          })
          return
        }

        if (mode === "ghostty") {
          const repo = await resolveRepoRoot(cwd)
          // Sessions that already exist must not be mistaken for the one we are about to open.
          const existing = new Set((await listLiveSessions(config, repo))?.map((x) => x.sessionId) ?? [])
          const opened = await openGhosttyTab({
            cwd,
            bin: resolveBinPath(config.bin),
            args: hunkArgs,
            path: process.env.PATH,
          })
          if (!opened.ok) {
            context.ui.toast.show({ title: "Hunk", message: opened.message ?? "Could not open a Ghostty tab", variant: "error" })
            return
          }
          context.ui.toast.show({ message: "Hunk opened in a new Ghostty tab", variant: "info" })
          watchInBackground(repo, sessionID, existing)
          return
        }

        const root = await requireGitRepo(cwd)
        if (!root) return
        const { comments, code } = await runSuspended({
          renderer: context.renderer,
          bin: config.bin,
          args: hunkArgs,
          cwd,
          pollMs: config.pollMs,
          fetchComments: async () => {
            const r = await fetchUserComments(config, root)
            return r.error ? undefined : r.comments
          },
        })
        if (code !== 0) context.ui.toast.show({ title: "Hunk", message: `hunk exited with code ${code}`, variant: "error" })
        await offerToSend(context, sessionID, comments)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        const message =
          code === "ENOENT"
            ? `Could not launch \`${mode === "tmux" ? "tmux" : config.bin}\` (not found). Install it or set the plugin options.`
            : error instanceof Error
              ? error.message
              : String(error)
        context.ui.toast.show({ title: "Hunk", message, variant: "error" })
      }
    }

    const send = async () => {
      const sessionID = currentSessionID(context)
      if (!sessionID) {
        context.ui.toast.show({ message: "Open a session first: /hunk-send sends comments to the current session", variant: "warning" })
        return
      }
      const repo = await resolveRepoRoot(resolveCwd(context, sessionID))
      const { comments, error } = await fetchUserComments(config, repo)
      if (error) {
        context.ui.toast.show({ title: "Hunk", message: error, variant: "error" })
        return
      }
      if (comments.length === 0) {
        context.ui.toast.show({ message: "No hunk comments to send. Add comments in Hunk first.", variant: "info" })
        return
      }
      try {
        await sendComments(context, sessionID, comments)
      } catch (err) {
        context.ui.toast.show({ title: "Hunk", message: err instanceof Error ? err.message : String(err), variant: "error" })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "hunk.open",
          title: "Open Hunk diff viewer",
          description: "Open hunk for the current repo. Extra args go to `hunk diff` (or `hunk show`).",
          group: "Hunk",
          palette: true,
          slash: { name: "hunk", arguments: true },
          run: (input) => open(input),
        },
        {
          id: "hunk.send",
          title: "Send Hunk comments to agent",
          description: "Send your inline Hunk comments from the live session to the current session.",
          group: "Hunk",
          palette: true,
          slash: { name: "hunk-send" },
          run: () => send(),
        },
      ],
    }))

    return () => watchers.stopAll()
  },
})
