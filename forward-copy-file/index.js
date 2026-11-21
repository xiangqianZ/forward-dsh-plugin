/**
 * @forward/copy-file — host half.
 *
 * One job: put a real local file on the macOS clipboard so the user can paste
 * it in Finder (or any other app) without first opening its containing folder.
 *
 * The browser cannot place a file item on the system clipboard — the Web
 * Clipboard API only accepts text and images. The Host therefore runs a tiny
 * AppleScript through `ctx.subprocess` (never a shell): the path is passed as
 * an argument to `on run argv`, so a quote, space, or newline in a filename is
 * just data and never becomes script text.
 *
 * The route is registered on `connection.fetch` under /api so it stays behind
 * the Host/Origin fence and the browser cookie check. Nothing here reads or
 * sends file contents: only an existence check and the clipboard write.
 *
 * @module @forward/copy-file
 */

import fs from 'node:fs'
import path from 'node:path'

/** Package name; also the client module-loader id and the locale namespace. */
export const PLUGIN_ID = '@forward/copy-file'

/** The one exact route both halves speak over. */
export const RPC_ROUTE = '/api/forward-copy-file/rpc'

/** No shell, no interpolation: the path arrives as argv[1]. */
const APPLESCRIPT = [
  'on run argv',
  '  set targetPath to item 1 of argv',
  '  set the clipboard to (POSIX file targetPath)',
  'end run',
].join('\n')

/** Milliseconds `osascript` gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2000

/** Upper bound for one clipboard request. */
const TIMEOUT_MS = 10000

/** Failure codes the browser half may surface. */
const CODES = {
  BAD_REQUEST: 'bad_request',
  NO_SESSION: 'no_session',
  NOT_FOUND: 'not_found',
  NOT_SUPPORTED: 'not_supported',
  NO_OSASCRIPT: 'no_osascript',
  COPY_FAILED: 'copy_failed',
  INTERNAL: 'internal',
}

/** HTTP status per failure code. */
const HTTP_STATUS = {
  [CODES.BAD_REQUEST]: 400,
  [CODES.NO_SESSION]: 409,
  [CODES.NOT_FOUND]: 404,
  [CODES.NOT_SUPPORTED]: 501,
  [CODES.NO_OSASCRIPT]: 503,
  [CODES.COPY_FAILED]: 500,
  [CODES.INTERNAL]: 500,
}

/** A failure with a stable code and a sentence the user can act on. */
class CopyFileError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CopyFileError'
    this.code = code
  }
}

function fail(code, message) {
  return new CopyFileError(code, message)
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
    throw fail(CODES.BAD_REQUEST, `缺少字段 ${name}。`)
  }
  return value
}

/**
 * Session workspace root, taken from the same header the workspace-files API
 * uses. A stale/offline Session falls back to the on-disk header and then the
 * sandbox policy root, so paths from an older conversation still resolve.
 */
async function workspaceRootOf(ctx, sessionId) {
  const header = ctx.sessions?.get?.(sessionId)?.header
  if (header === undefined || header === null) {
    const persistence = ctx.get?.('sessionPersistence', false)
    if (persistence !== undefined && typeof persistence.stat === 'function') {
      try {
        const stored = await persistence.stat(sessionId)
        return stored?.header?.cwd
      } catch {
        // Fall through to the policy root.
      }
    }
  }
  const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  if (cwd !== undefined) return cwd
  const fromPolicy = ctx.get?.('sandboxPolicy', false)?.workspaceRoot
  return typeof fromPolicy === 'string' && fromPolicy !== '' ? fromPolicy : undefined
}

/** Resolve a menu target path to an existing absolute file or directory. */
async function resolveTarget(ctx, payload) {
  const sessionId = stringField(payload, 'sessionId')
  const supplied = stringField(payload, 'path')
  if (supplied.includes('\0')) throw fail(CODES.BAD_REQUEST, '路径包含非法字符。')

  const root = await workspaceRootOf(ctx, sessionId)
  if (root === undefined && !path.isAbsolute(supplied)) {
    throw fail(CODES.NO_SESSION, '拿不到这个会话的工作区目录，无法解析相对路径。')
  }
  const absolute = path.resolve(root ?? process.cwd(), supplied)

  let info
  try {
    info = fs.statSync(absolute)
  } catch {
    throw fail(CODES.NOT_FOUND, '文件已不存在或无法访问。')
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw fail(CODES.NOT_FOUND, '这个路径不是普通文件或目录。')
  }
  return { sessionId, absolute }
}

/** Run the smallest possible AppleScript; the path never enters the script text. */
async function writeClipboard(ctx, absolute, signal) {
  if (process.platform !== 'darwin') {
    throw fail(CODES.NOT_SUPPORTED, '复制文件目前仅支持 macOS。')
  }

  let executable
  try {
    executable = await ctx.subprocess.resolveExecutable('osascript', undefined, signal)
  } catch (error) {
    throw fail(CODES.NO_OSASCRIPT, `找不到 osascript：${String(error?.message ?? error)}`)
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const cwd = process.cwd()

  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [executable, '-e', APPLESCRIPT, absolute],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 16 * 1024 },
        stderr: { maxBytes: 16 * 1024 },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal: combined,
    })
  } catch (error) {
    throw fail(CODES.COPY_FAILED, `无法启动剪贴板命令：${String(error?.message ?? error)}`)
  }

  const outcome = await handle.done
  if (outcome.exitCode !== 0) {
    const err = handle.collected.stderr?.readFrom(0)?.text?.trim() ?? ''
    throw fail(CODES.COPY_FAILED, err === ''
      ? `复制失败（退出码 ${outcome.exitCode}）。`
      : `复制失败：${err}`)
  }
}

/** Normalize any thrown value into `{ code, message, status }`. */
function describeError(error) {
  if (error instanceof CopyFileError) {
    return { code: error.code, message: error.message, status: HTTP_STATUS[error.code] ?? 400 }
  }
  return {
    code: CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error),
    status: HTTP_STATUS[CODES.INTERNAL],
  }
}

/** Services this plugin needs. */
export const inject = ['connection', 'sessions', 'subprocess']

/** Stable Loader/plugin identity. */
export const name = 'copy-file'

/** Install the host half. */
export function apply(ctx) {
  const handlers = {
    async copy(payload, request) {
      const { absolute } = await resolveTarget(ctx, payload)
      await writeClipboard(ctx, absolute, request.signal)
      return { path: absolute }
    },
  }

  const route = {
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
        return json({ ok: false, error: { code: CODES.BAD_REQUEST, message: `未知的 action：${JSON.stringify(action)}` } }, 400)
      }
      try {
        return json({ ok: true, ...await handler(payload, request) })
      } catch (error) {
        const described = describeError(error)
        if (described.code === CODES.INTERNAL) {
          ctx.logger?.warn?.(`forward-copy-file: ${action} failed: ${described.message}`)
        }
        return json({ ok: false, error: { code: described.code, message: described.message } }, described.status)
      }
    },
  }

  // `connection` may arrive after this plugin, and ctx.inject can fire the
  // callback immediately once it does; the guard keeps one registration only.
  let registered = false
  const install = (scope) => {
    if (registered) return
    const connection = scope.get('connection', false)
    if (connection?.fetch?.register === undefined) return
    scope.effect(() => connection.fetch.register(route), 'forward-copy-file: rpc route')
    registered = true
  }

  install(ctx)
  ctx.inject(['connection'], scope => install(scope))
}
