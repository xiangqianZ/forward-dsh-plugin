/**
 * forward-process-manager — Host half.
 *
 * One authenticated RPC route answers two questions for the browser half:
 * which OS processes belong to the current Session's workspace, and
 * how to stop one of them. Everything runs through `ctx.subprocess`; nothing
 * shells out through `node:child_process`.
 *
 * Ownership is decided by where the *launching DSH session* was created, not
 * by the process's own cwd: DSH stamps every child with `DSH_SESSION_ID`, and
 * that session's cwd is the workspace the process belongs to. Processes DSH
 * did not stamp fall back to cwd/command-line matching.
 *
 * The route is registered on `connection.fetch` under `/api/...` on purpose:
 * that is where the Host/Origin fence and the browser cookie check live, so a
 * page that merely guesses the path cannot list or kill processes.
 *
 * @module @forward/process-manager
 */

import { realpath } from 'node:fs/promises'

/** Package name; also the client module-loader id. */
export const PLUGIN_ID = '@forward/process-manager'

/** The one exact Fetch route both halves speak over. */
export const RPC_ROUTE = '/api/forward-process-manager/rpc'

/** Cordis plugin name / Loader row id. */
export const name = 'project-processes'

/** Small services we cannot work without. `connection` is waited for separately. */
export const inject = ['subprocess', 'sessions']

const MAX_PROCESSES = 100
const MAX_COMMAND_CHARS = 400
const LIST_TIMEOUT_MS = 5000
const KILL_TIMEOUT_MS = 5000
const KILL_GRACE_MS = 1500

const CODES = {
  BAD_REQUEST: 'E_BAD_REQUEST',
  NO_WORKSPACE: 'E_NO_WORKSPACE',
  NO_PS: 'E_NO_PS',
  LIST_FAILED: 'E_LIST_FAILED',
  NOT_FOUND: 'E_NOT_FOUND',
  NO_KILL: 'E_NO_KILL',
  KILL_FAILED: 'E_KILL_FAILED',
  INTERNAL: 'E_INTERNAL',
}

const HTTP_STATUS = {
  [CODES.BAD_REQUEST]: 400,
  [CODES.NO_WORKSPACE]: 409,
  [CODES.NO_PS]: 503,
  [CODES.LIST_FAILED]: 500,
  [CODES.NOT_FOUND]: 404,
  [CODES.NO_KILL]: 503,
  [CODES.KILL_FAILED]: 500,
  [CODES.INTERNAL]: 500,
}

class ProcessError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProcessError'
    this.code = code
  }
}

/** JSON response that is never cached by the browser or a proxy. */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Required non-empty string field. */
function stringField(payload, field) {
  const value = payload?.[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProcessError(CODES.BAD_REQUEST, `缺少字段 ${field}。`)
  }
  return value
}

/**
 * Which directory is this Session's workspace?
 * Same source of truth as the shipped workspace-files API and forward-git-commit.
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

/** Run one short managed child; non-zero exit is data, not an exception. */
async function run(ctx, argv, { signal, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  const combined = timeout === undefined
    ? signal
    : signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  const handle = ctx.subprocess.spawn({
    argv,
    cwd: '/', // Never let our own ps/lsof children look like project processes.
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: KILL_GRACE_MS,
    ...(combined === undefined ? {} : { signal: combined }),
  })
  const outcome = await handle.done
  const out = handle.collected.stdout?.readFrom(0) ?? { text: '' }
  const err = handle.collected.stderr?.readFrom(0) ?? { text: '' }
  return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: out.text, stderr: err.text }
}

/** Parse `ps -axo pid=,ppid=,etime=,command=` lines. */
export function parsePs(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    const matched = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(text)
    if (matched === null) continue
    const pid = Number(matched[1])
    const ppid = Number(matched[2])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    rows.push({
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : 0,
      etime: matched[3],
      command: matched[4].slice(0, MAX_COMMAND_CHARS),
    })
  }
  return rows
}

/** Parse `ps e -axo pid=,command=` into pid -> DSH_SESSION_ID. */
export function parseEnvPs(stdout) {
  const sessionByPid = new Map()
  for (const line of stdout.split('\n')) {
    const matched = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (matched === null) continue
    const pid = Number(matched[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const token = /(?:^|\s)DSH_SESSION_ID=(\S+)/.exec(matched[2])
    if (token === null) continue
    sessionByPid.set(pid, token[1])
  }
  return sessionByPid
}

/** Parse `lsof -nP -a -d cwd -Fpcn` into pid -> cwd. */
export function parseLsof(stdout) {
  const cwdByPid = new Map()
  let pid = null
  let isCwd = false
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const kind = line[0]
    if (kind === 'p') {
      const parsed = Number(line.slice(1))
      pid = Number.isSafeInteger(parsed) ? parsed : null
      isCwd = false
    } else if (kind === 'f') {
      isCwd = line.slice(1) === 'cwd'
    } else if (kind === 'n' && isCwd && pid !== null) {
      cwdByPid.set(pid, line.slice(1))
      isCwd = false
    }
  }
  return cwdByPid
}

/** Parse `lsof -i -Fpcn` into pid -> listening UDP/TCP ports. */
export function parseListeners(stdout) {
  const portsByPid = new Map()
  let pid = null
  let isCwd = false
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const kind = line[0]
    if (kind === 'p') {
      const parsed = Number(line.slice(1))
      pid = Number.isSafeInteger(parsed) ? parsed : null
      isCwd = false
    } else if (kind === 'f') {
      isCwd = line.slice(1) === 'cwd'
    } else if (kind === 'n' && !isCwd && pid !== null) {
      const port = /:(\d+)$/.exec(line.slice(1))
      if (port === null) continue
      const value = Number(port[1])
      if (!Number.isInteger(value) || value < 1 || value > 65535) continue
      const ports = portsByPid.get(pid) ?? []
      if (!ports.includes(value)) ports.push(value)
      portsByPid.set(pid, ports)
    }
  }
  for (const ports of portsByPid.values()) ports.sort((a, b) => a - b)
  return portsByPid
}

/** True when `path` is `root` or sits under it. */
export function inside(path, root) {
  if (typeof path !== 'string' || path === '') return false
  if (path === root) return true
  return path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** pids of this process and its ancestors — never offer to stop our own family. */
function ownFamily(rows) {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]))
  const family = new Set([process.pid])
  let cursor = process.pid
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = parentOf.get(cursor)
    if (parent === undefined || parent === 0 || family.has(parent)) break
    family.add(parent)
    cursor = parent
  }
  return family
}

/** Build the complete answer for one Session's project. */
export async function listProcesses(ctx, sessionId, signal) {
  const cwd = await workspaceOf(ctx, sessionId)
  if (cwd === undefined) {
    throw new ProcessError(CODES.NO_WORKSPACE, '拿不到这个会话的工作区目录，无法定位当前项目。')
  }
  const root = await realpath(cwd).catch(() => cwd)

  /**
   * Workspace root of any session by id, realpath'd. Used to attribute a
   * process to the workspace where its launching session was created, which
   * may differ from the process's own cwd (e.g. `cd other/dir && ./server`).
   */
  const sessionRoot = new Map()
  const workspaceOfSession = async (sessionId) => {
    if (sessionRoot.has(sessionId)) return sessionRoot.get(sessionId)
    const sessionCwd = await workspaceOf(ctx, sessionId)
    const resolved = sessionCwd === undefined ? undefined : await realpath(sessionCwd).catch(() => sessionCwd)
    sessionRoot.set(sessionId, resolved)
    return resolved
  }

  let psExecutable
  try {
    psExecutable = await ctx.subprocess.resolveExecutable('ps', undefined, signal)
  } catch (error) {
    throw new ProcessError(CODES.NO_PS, `找不到 ps 可执行文件：${String(error?.message ?? error)}`)
  }
  const ps = await run(ctx, [psExecutable, '-axo', 'pid=,ppid=,etime=,command='], { signal })
  if (ps.exitCode !== 0) {
    throw new ProcessError(CODES.LIST_FAILED, `ps 退出码 ${ps.exitCode}：${ps.stderr.trim() || '无输出'}`)
  }
  const rows = parsePs(ps.stdout)

  // DSH stamps every process it spawns with DSH_SESSION_ID. That is the source
  // of truth for which session — and therefore which workspace — launched a
  // process, independent of the directory it later `cd`'d into. Read it from
  // `ps e`, keyed by pid, so a server started from workspace A but running out
  // of directory B still shows up in A (and only A).
  let sessionByPid = new Map()
  try {
    const envPs = await run(ctx, [psExecutable, 'e', '-axo', 'pid=,command='], { signal })
    if (envPs.exitCode === 0) sessionByPid = parseEnvPs(envPs.stdout)
  } catch {
    // The env view is a best effort; fall back to cwd/command matching below.
  }

  // cwd improves recall for processes DSH did not stamp (started directly in a
  // terminal, older processes): a `pnpm dev` started in the project has no
  // project path in its command line, but lsof still reports its cwd.
  let cwdByPid = new Map()
  try {
    const lsof = await ctx.subprocess.resolveExecutable('lsof', undefined, signal)
    const result = await run(ctx, [lsof, '-nP', '-a', '-d', 'cwd', '-Fpcn'], { signal })
    if (result.stdout !== '') cwdByPid = parseLsof(result.stdout)
  } catch {
    // lsof is an enhancement; command-line matching still works without it.
  }

  // Only listeners matter: a project process that does not own a TCP/UDP
  // port is not shown at all.
  let portsByPid = new Map()
  try {
    const lsof = await ctx.subprocess.resolveExecutable('lsof', undefined, signal)
    for (const args of [['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], ['-nP', '-iUDP', '-Fpcn']]) {
      const result = await run(ctx, [lsof, ...args], { signal })
      if (result.stdout === '') continue
      for (const [pid, ports] of parseListeners(result.stdout)) {
        const merged = portsByPid.get(pid) ?? []
        for (const port of ports) if (!merged.includes(port)) merged.push(port)
        portsByPid.set(pid, merged.sort((a, b) => a - b))
      }
    }
  } catch {
    // Without lsof there is no reliable port view; the list stays empty.
  }

  const family = ownFamily(rows)
  const processes = []
  for (const row of rows) {
    if (family.has(row.pid)) continue
    const ports = portsByPid.get(row.pid)
    if (ports === undefined || ports.length === 0) continue
    const commandMatch = row.command.includes(root)
    const processCwd = cwdByPid.get(row.pid)
    const cwdMatch = inside(processCwd, root)
    const launchSessionId = sessionByPid.get(row.pid)
    const launchRoot = launchSessionId === undefined ? undefined : await workspaceOfSession(launchSessionId)
    const sessionMatch = launchRoot !== undefined && launchRoot === root
    // A stamped process belongs to the workspace of its launching session,
    // regardless of its own cwd/command line. If that session cannot be
    // resolved (log gone), fall back to command/cwd instead of dropping it.
    const belongs = launchRoot !== undefined
      ? sessionMatch
      : commandMatch || cwdMatch
    if (!belongs) continue
    processes.push({
      pid: row.pid,
      ppid: row.ppid,
      etime: row.etime,
      command: row.command,
      cwd: processCwd ?? null,
      ports,
      sessionId: launchSessionId ?? null,
      matchedBy: sessionMatch
        ? 'session'
        : commandMatch && cwdMatch ? 'both' : commandMatch ? 'command' : 'cwd',
    })
    if (processes.length >= MAX_PROCESSES) break
  }
  processes.sort((left, right) => left.pid - right.pid)

  // A launcher shell (`bash -c ... && nohup node server.mjs`) matches by
  // command line and is the parent of the real service. Showing both counts
  // one service twice, so hide matched *shell wrappers* that are ancestors
  // of another matched process. A real service that happens to spawn a child
  // (for example a TTS helper) must stay visible.
  const matched = new Set(processes.map((item) => item.pid))
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]))
  const commandOf = new Map(processes.map((item) => [item.pid, item.command]))
  const isLauncherAncestor = (pid) => {
    if (!/\b(?:bash|sh|zsh)\s+-c\s/.test(commandOf.get(pid) ?? '')) return false
    for (const other of matched) {
      if (other === pid) continue
      let cursor = parentOf.get(other)
      for (let depth = 0; cursor !== undefined && cursor !== 0 && depth < 32; depth += 1) {
        if (cursor === pid) return true
        cursor = parentOf.get(cursor)
      }
    }
    return false
  }
  const visible = processes.filter((item) => !isLauncherAncestor(item.pid))

  return {
    cwd: root,
    at: new Date().toISOString(),
    total: visible.length,
    truncated: visible.length >= MAX_PROCESSES,
    processes: visible,
  }
}

/** Cancel one process that the caller can actually see in its project list. */
export async function stopProcess(ctx, payload, signal) {
  const sessionId = stringField(payload, 'sessionId')
  const pid = Number(payload?.pid)
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new ProcessError(CODES.BAD_REQUEST, 'pid 必须是大于 1 的整数。')
  }
  const force = payload?.force === true

  const list = await listProcesses(ctx, sessionId, signal)
  if (!list.processes.some((item) => item.pid === pid)) {
    throw new ProcessError(CODES.NOT_FOUND, `进程 ${pid} 已不在当前项目列表中。`)
  }

  let killExecutable
  try {
    killExecutable = await ctx.subprocess.resolveExecutable('kill', undefined, signal)
  } catch (error) {
    throw new ProcessError(CODES.NO_KILL, `找不到 kill 可执行文件：${String(error?.message ?? error)}`)
  }
  const result = await run(ctx, [killExecutable, force ? '-KILL' : '-TERM', String(pid)], {
    signal,
    timeoutMs: KILL_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `退出码 ${result.exitCode}`
    throw new ProcessError(CODES.KILL_FAILED, `停止进程 ${pid} 失败：${detail}`)
  }
  return { pid, signal: force ? 'SIGKILL' : 'SIGTERM', at: new Date().toISOString() }
}

/** Turn a thrown value into a stable wire error. */
function describeError(error) {
  if (error instanceof ProcessError) {
    return { code: error.code, message: error.message, status: HTTP_STATUS[error.code] ?? 400 }
  }
  return {
    code: CODES.INTERNAL,
    message: String(error?.message ?? error),
    status: HTTP_STATUS[CODES.INTERNAL],
  }
}

function handlersOf(ctx) {
  return {
    list(payload, request) {
      const sessionId = stringField(payload, 'sessionId')
      return listProcesses(ctx, sessionId, request.signal)
    },
    stop(payload, request) {
      return stopProcess(ctx, payload, request.signal)
    },
  }
}

/** One authenticated JSON-RPC-ish route with an explicit action switch. */
function createRoute(ctx) {
  const handlers = handlersOf(ctx)
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
        return json({ ok: false, error: { code: CODES.BAD_REQUEST, message: '请求体必须是 JSON 对象。' } }, 400)
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
          ctx.logger?.warn?.(`forward-process-manager: ${action} failed: ${described.message}`)
        }
        return json({ ok: false, error: described }, described.status)
      }
    },
  }
}

/** Register the route once, whenever `connection` becomes available. */
export function apply(ctx) {
  let registered = false
  const install = (scope) => {
    if (registered) return
    const connection = scope.get('connection', false)
    if (connection?.fetch?.register === undefined) return
    scope.effect(() => connection.fetch.register(createRoute(ctx)), 'forward-process-manager: rpc route')
    registered = true
  }
  install(ctx)
  ctx.inject(['connection'], (scope) => install(scope))
}
