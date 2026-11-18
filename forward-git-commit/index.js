/**
 * forward-git-commit — host half.
 *
 * One job: run `git add -A`, `git commit`, `git push` for the Session's
 * workspace, and answer the two questions the header button needs — "which
 * branch is this, and is there anything to commit?"
 *
 * Why a Host half at all: the browser cannot run git. Every command goes
 * through `ctx.subprocess`, which resolves the executable, contains the child,
 * bounds its output, and scrubs the ambient environment of credential-shaped
 * names. Nothing here shells out through `node:child_process`.
 *
 * Why an exact Fetch route on `connection.fetch` rather than a `webServer`
 * route: the `/api` prefix route is where the Host/Origin fence and the browser
 * cookie check live. An exact `webServer` route on the same pathname resolves
 * *before* that prefix and would expose an unauthenticated git surface to any
 * page that can guess the path.
 *
 * What this plugin deliberately will not do: `push --force`, `reset --hard`,
 * `clean`, or `checkout --`. A one-click button must be safe to press by
 * accident; a rejected push is reported, never reconciled by rewriting history.
 *
 * @module @forward/git-commit
 */

/** Package name; also the client module-loader id and the locale namespace. */
export const PLUGIN_ID = '@forward/git-commit'

/** The one exact Fetch route both halves speak over. */
export const RPC_ROUTE = '/api/forward-git-commit/rpc'

/** Environment every git child starts from. */
const GIT_ENV = {
  // A credential prompt would hang a headless child forever.
  GIT_TERMINAL_PROMPT: '0',
  // Do not take optional index locks a concurrent command could hold.
  GIT_OPTIONAL_LOCKS: '0',
  // No pager, and a stable locale so the output we classify is the one we expect.
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
}

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2000

/** Default stdout ceiling for one command. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** `git rev-parse` exits 128 when the directory is not inside a repository. */
const NOT_A_REPOSITORY_EXIT = 128

/** The one stderr signature that means "not a repository" rather than "broken". */
const NOT_A_REPOSITORY = /not a git repository/i

/** Failure codes the browser half branches on. */
const CODES = {
  BAD_REQUEST: 'E_BAD_REQUEST',
  NO_WORKSPACE: 'E_NO_WORKSPACE',
  NO_REPO: 'E_NO_REPO',
  NO_GIT: 'E_NO_GIT',
  EMPTY_MESSAGE: 'E_EMPTY_MESSAGE',
  NOTHING_TO_COMMIT: 'E_NOTHING_TO_COMMIT',
  NO_REMOTE: 'E_NO_REMOTE',
  PUSH_REJECTED: 'E_PUSH_REJECTED',
  AUTH: 'E_AUTH',
  GIT_FAILED: 'E_GIT_FAILED',
  INTERNAL: 'E_INTERNAL',
}

/** HTTP status per failure code; the body carries the code as well. */
const HTTP_STATUS = {
  [CODES.BAD_REQUEST]: 400,
  [CODES.NO_WORKSPACE]: 409,
  [CODES.NO_REPO]: 409,
  [CODES.NO_GIT]: 503,
  [CODES.EMPTY_MESSAGE]: 400,
  [CODES.NOTHING_TO_COMMIT]: 409,
  [CODES.NO_REMOTE]: 409,
  [CODES.PUSH_REJECTED]: 409,
  [CODES.AUTH]: 401,
  [CODES.GIT_FAILED]: 500,
  [CODES.INTERNAL]: 500,
}

/** A failure with a stable code and a sentence the user can act on. */
class GitCommitError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GitCommitError'
    this.code = code
  }
}

/** A git command that ran and failed, carrying its command and output. */
class GitFailure extends Error {
  constructor(command, result) {
    const detail = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim()
    super(detail === '' ? `${command} failed (exit ${result.exitCode})` : `${command} failed: ${detail}`)
    this.name = 'GitFailure'
    this.command = command
    this.exitCode = result.exitCode
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

/** A JSON response that is never cached. */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a required non-empty string field. */
function stringField(payload, name) {
  const value = payload?.[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GitCommitError(CODES.BAD_REQUEST, `缺少字段 ${name}。`)
  }
  return value
}

/**
 * Build the git runner for one plugin instance.
 *
 * Never throws for a non-zero exit code — that is data. Throws only when the
 * child could not be started, or when the timeout/abort fired.
 *
 * @param {object} ctx host context (must have `subprocess` injected)
 */
function createGit(ctx) {
  let resolved

  /** Resolve the git executable once per plugin instance. */
  async function executable(signal) {
    if (resolved !== undefined) return resolved
    try {
      resolved = await ctx.subprocess.resolveExecutable('git', undefined, signal)
    } catch (error) {
      throw new GitCommitError(CODES.NO_GIT, `找不到 git 可执行文件：${String(error?.message ?? error)}`)
    }
    return resolved
  }

  /**
   * Run one git command.
   *
   * @param {readonly string[]} args arguments after the executable
   * @param {{cwd?: string, signal?: AbortSignal, stdin?: string, timeoutMs?: number, maxBytes?: number}} [options]
   */
  async function run(args, options = {}) {
    const executablePath = await executable(options.signal)
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    const signal = timeout === undefined
      ? options.signal
      : options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout])

    const label = `git ${args[0] ?? ''}`.trim()
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [executablePath, ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? MAX_OUTPUT_BYTES },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: TERMINATE_GRACE_MS,
        ...(signal === undefined ? {} : { signal }),
        env: GIT_ENV,
      })
    } catch (error) {
      throw new GitFailure(label, { exitCode: null, stdout: '', stderr: String(error?.message ?? error) })
    }

    const outcome = await handle.done
    const out = handle.collected.stdout?.readFrom(0) ?? { text: '' }
    const err = handle.collected.stderr?.readFrom(0) ?? { text: '' }
    return { exitCode: outcome.exitCode, stdout: out.text, stderr: err.text }
  }

  return { executable, run }
}

/**
 * Which directory is this Session's workspace?
 *
 * Taken from the same place the shipped workspace-files API takes it: the
 * session header's `cwd`, falling back to the sandbox policy's workspace root.
 * A workspace record's `sessionIds` is *not* authoritative — the registry only
 * indexes sessions that existed when the Host booted.
 *
 * @param {object} ctx host context
 * @param {string} sessionId
 */
async function workspaceOf(ctx, sessionId) {
  const live = ctx.sessions?.get?.(sessionId)?.header
  let header = live
  if (header === undefined || header === null) {
    const persistence = ctx.get?.('sessionPersistence', false)
    if (persistence !== undefined && typeof persistence.stat === 'function') {
      try {
        header = (await persistence.stat(sessionId))?.header
      } catch {
        header = undefined
      }
    }
  }
  if (header === undefined || header === null) return undefined

  const fromPolicy = ctx.get?.('sandboxPolicy', false)?.workspaceRoot
  const cwd = typeof header.cwd === 'string' && header.cwd !== ''
    ? header.cwd
    : typeof fromPolicy === 'string' ? fromPolicy : ''
  return cwd === '' ? undefined : cwd
}

/**
 * Turn a failed git command into the sentence the user should read.
 *
 * @param {GitFailure} failure
 */
function classify(failure) {
  const text = `${failure.stderr}\n${failure.stdout}`
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(text)) {
    return new GitCommitError(
      CODES.PUSH_REJECTED,
      '远端有本地没有的提交，推送被拒绝。先 pull 或 rebase，再提交。',
    )
  }
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled/i.test(text)) {
    return new GitCommitError(
      CODES.AUTH,
      '推送认证失败：本机 git 没有可用凭据。先在终端里成功 push 一次，或配好凭据助手 / SSH key。',
    )
  }
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return new GitCommitError(CODES.NOTHING_TO_COMMIT, '没有可提交的改动。')
  }
  return new GitCommitError(CODES.GIT_FAILED, failure.message)
}

/**
 * Build the action handlers.
 *
 * @param {object} ctx host context
 * @param {ReturnType<typeof createGit>} git
 */
function createHandlers(ctx, git) {
  /**
   * The repository root containing this Session's workspace, or a coded error.
   *
   * `rev-parse --show-toplevel` walks upward, so a Session opened in a
   * subdirectory of a repository still finds the right root.
   */
  async function requireRepo(payload, signal) {
    const sessionId = stringField(payload, 'sessionId')
    const cwd = await workspaceOf(ctx, sessionId)
    if (cwd === undefined) {
      throw new GitCommitError(CODES.NO_WORKSPACE, '拿不到这个会话的工作区目录，无法定位仓库。')
    }
    const result = await git.run(['rev-parse', '--show-toplevel'], { cwd, signal })
    if (result.exitCode === NOT_A_REPOSITORY_EXIT && NOT_A_REPOSITORY.test(result.stderr)) {
      throw new GitCommitError(CODES.NO_REPO, '当前工作区不是 Git 仓库（或不在任何仓库里）。')
    }
    if (result.exitCode !== 0) throw classify(new GitFailure('git rev-parse --show-toplevel', result))
    const root = result.stdout.split('\n')[0]?.trim() ?? ''
    if (root === '') throw new GitCommitError(CODES.NO_REPO, '当前工作区不是 Git 仓库。')
    return { sessionId, cwd, root }
  }

  /**
   * The branch name, or null when HEAD is detached.
   *
   * `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`: the latter exits
   * 128 on a repository with no commits yet, which would report a brand-new
   * repository as detached and refuse the very first commit. An unborn branch
   * still has a symbolic ref, so this answers `main` where the other answers
   * nothing.
   */
  async function branchOf(root, signal) {
    const symbolic = await git.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, signal })
    if (symbolic.exitCode === 0) {
      const name = symbolic.stdout.trim()
      if (name !== '') return name
    }
    return null
  }

  /** `origin` when it exists, else the first remote, else null. */
  async function remoteOf(root, signal) {
    const result = await git.run(['remote'], { cwd: root, signal })
    if (result.exitCode !== 0) return null
    const remotes = result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (remotes.length === 0) return null
    return remotes.includes('origin') ? 'origin' : remotes[0]
  }

  /** Working-tree counts from one porcelain v1 read. */
  async function changesOf(root, signal) {
    const result = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, signal })
    if (result.exitCode !== 0) throw classify(new GitFailure('git status', result))
    // `-z` separates records with NUL; a rename record carries its source path as
    // the following field, which is not a record of its own.
    const fields = result.stdout.split('\0')
    let total = 0
    let staged = 0
    let unstaged = 0
    let untracked = 0
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]
      if (field.length < 3) continue
      const x = field[0]
      const y = field[1]
      total += 1
      if (x === '?') {
        untracked += 1
      } else {
        if (x !== ' ' && x !== '?') staged += 1
        if (y !== ' ') unstaged += 1
      }
      if (x === 'R' || x === 'C') index += 1
    }
    return { total, staged, unstaged, untracked }
  }

  /** Ahead/behind against the branch's upstream, or nulls without one. */
  async function aheadBehindOf(root, signal) {
    const result = await git.run(
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      { cwd: root, signal },
    )
    if (result.exitCode !== 0) return { upstream: null, ahead: null, behind: null }
    const [behindText, aheadText] = result.stdout.trim().split(/\s+/)
    const behind = Number.parseInt(behindText ?? '', 10)
    const ahead = Number.parseInt(aheadText ?? '', 10)
    return {
      upstream: true,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
    }
  }

  /** The panel's whole state for one Session. */
  async function status(payload, request) {
    const { cwd, root } = await requireRepo(payload, request.signal)
    const [branch, remote, changes, sync] = await Promise.all([
      branchOf(root, request.signal),
      remoteOf(root, request.signal),
      changesOf(root, request.signal),
      aheadBehindOf(root, request.signal),
    ])
    return { workspace: cwd, repo: root, branch, remote, changes, ...sync }
  }

  /**
   * Stage everything, commit with the given message, push.
   *
   * Staging is `add -A`: the button's promise is "commit what I have and send it
   * up", so a change the user forgot to stage must not be silently left behind.
   * The dialog states the file count before this runs, so the scope is visible.
   */
  async function commitPush(payload, request) {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
    if (message === '') throw new GitCommitError(CODES.EMPTY_MESSAGE, '提交信息不能为空。')

    const { root } = await requireRepo(payload, request.signal)
    const branch = await branchOf(root, request.signal)
    if (branch === null) {
      throw new GitCommitError(CODES.BAD_REQUEST, 'HEAD 处于游离状态（detached），先切到一个分支再提交。')
    }
    const remote = await remoteOf(root, request.signal)
    if (remote === null) {
      throw new GitCommitError(CODES.NO_REMOTE, '这个仓库没有配置远端（remote），无法推送。')
    }

    const add = await git.run(['add', '-A'], { cwd: root, signal: request.signal })
    if (add.exitCode !== 0) throw classify(new GitFailure('git add', add))

    // The message goes in over stdin rather than as `-m`: a summary with a
    // quote, a newline, or a leading dash is then just text, not an argument.
    const commit = await git.run(['commit', '-F', '-'], {
      cwd: root,
      stdin: `${message}\n`,
      signal: request.signal,
    })
    if (commit.exitCode !== 0) throw classify(new GitFailure('git commit', commit))

    const head = await git.run(['log', '-1', '--pretty=%H%x00%h%x00%s'], { cwd: root, signal: request.signal })
    const [oid, short, ...subject] = head.exitCode === 0
      ? head.stdout.replace(/\n$/, '').split('\0')
      : ['', '', '']

    // A branch with no upstream is published on this first push. Anything else
    // is a plain push; a rejection is reported, never forced.
    const sync = await aheadBehindOf(root, request.signal)
    const args = sync.upstream === null
      ? ['push', '--set-upstream', remote, 'HEAD']
      : ['push', remote]
    const push = await git.run(args, { cwd: root, signal: request.signal, timeoutMs: 120000 })
    if (push.exitCode !== 0) {
      // The commit already landed. Say so, so the user knows a retry will only
      // need the push — not a second commit.
      const failure = classify(new GitFailure('git push', push))
      failure.message = `提交已创建（${short || oid || 'HEAD'}），但推送失败：${failure.message}`
      throw failure
    }

    return {
      repo: root,
      branch,
      remote,
      published: sync.upstream === null,
      oid: oid === '' ? null : oid,
      short: short === '' ? null : short,
      subject: subject.join('\0'),
      output: `${push.stdout}${push.stderr}`.trim(),
    }
  }

  return { status, commitPush }
}

/** Normalize any thrown value into `{ code, message, status }`. */
function describeError(error) {
  if (error instanceof GitCommitError) {
    return { code: error.code, message: error.message, status: HTTP_STATUS[error.code] ?? 400 }
  }
  if (error?.name === 'GitFailure') {
    const mapped = classify(error)
    return { code: mapped.code, message: mapped.message, status: HTTP_STATUS[mapped.code] ?? 500 }
  }
  return {
    code: CODES.INTERNAL,
    message: String(error?.message ?? error),
    status: HTTP_STATUS[CODES.INTERNAL],
  }
}

/**
 * Build the one route.
 *
 * @param {{handlers: ReturnType<typeof createHandlers>, logger?: object}} deps
 */
function createRoute({ handlers, logger }) {
  return {
    path: RPC_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let payload
      try {
        payload = await request.json()
      } catch {
        return json({ ok: false, error: { code: CODES.BAD_REQUEST, message: '请求体不是合法 JSON。' } }, 400)
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return json({ ok: false, error: { code: CODES.BAD_REQUEST, message: '请求体必须是一个 JSON 对象。' } }, 400)
      }

      const action = typeof payload.action === 'string' ? payload.action : ''
      const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : undefined
      if (typeof handler !== 'function') {
        return json(
          { ok: false, error: { code: CODES.BAD_REQUEST, message: `未知的 action：${JSON.stringify(action)}` } },
          400,
        )
      }

      try {
        return json({ ok: true, ...await handler(payload, request) })
      } catch (error) {
        const described = describeError(error)
        if (described.code === CODES.INTERNAL) {
          logger?.warn?.(`forward-git-commit: action ${action} failed: ${described.message}`)
        }
        return json({ ok: false, error: { code: described.code, message: described.message } }, described.status)
      }
    },
  }
}

/** Services this plugin needs before it can do anything. */
export const inject = ['subprocess', 'sessions']

/** Cordis plugin name; also the Loader row identity. */
export const name = 'git-commit'

/**
 * Install the host half.
 *
 * @param {object} ctx host context
 */
export function apply(ctx) {
  const git = createGit(ctx)
  const handlers = createHandlers(ctx, git)
  const route = createRoute({ handlers, logger: ctx.logger })

  /**
   * Register the route on the preferred carrier, exactly once.
   *
   * The guard is load-bearing: `connection` may already be present when this
   * plugin loads, in which case `ctx.inject` fires its callback immediately *as
   * well as* the direct attempt running — and `fetch.register` rejects a second
   * registration of the same path.
   */
  let registered = false
  const install = (scope) => {
    if (registered) return
    const connection = scope.get('connection', false)
    if (connection?.fetch?.register === undefined) return
    scope.effect(() => connection.fetch.register(route), 'forward-git-commit: rpc route')
    registered = true
  }

  install(ctx)
  // Services load in no guaranteed order; wait for `connection` the public way.
  ctx.inject(['connection'], scope => install(scope))
}
