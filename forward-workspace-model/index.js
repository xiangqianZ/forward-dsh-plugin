/**
 * @forward/workspace-model — Host half.
 *
 * Keeps one model binding per registered DSH workspace and applies it only when
 * a brand-new Session is created. Session-level switches stay untouched: the
 * plugin writes `model/selection` directly through Agent.model and never calls
 * session/selectModel, so it neither changes the deployment default nor
 * rewrites an existing Session's own choice.
 */
import fs from 'node:fs'
import path from 'node:path'

const RPC_ROUTE = '/api/forward-workspace-model/rpc'

const CODES = {
  BAD_REQUEST: 'bad_request',
  WORKSPACE_NOT_FOUND: 'workspace_not_found',
  MODEL_UNAVAILABLE: 'model_unavailable',
  CONFIG_UNAVAILABLE: 'config_unavailable',
  INTERNAL: 'internal',
}

const HTTP_STATUS = {
  [CODES.BAD_REQUEST]: 400,
  [CODES.WORKSPACE_NOT_FOUND]: 404,
  [CODES.MODEL_UNAVAILABLE]: 422,
  [CODES.CONFIG_UNAVAILABLE]: 503,
  [CODES.INTERNAL]: 500,
}

class PluginError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceModelError'
    this.code = code
  }
}

function fail(code, message) {
  return new PluginError(code, message)
}

/** A JSON response that is never cached. */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Canonical path for stable workspace keys, tolerant of deleted paths. */
function real(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Read a required non-empty string field. */
function stringField(payload, name) {
  const value = payload?.[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(CODES.BAD_REQUEST, `缺少字段 ${name}。`)
  }
  return value.trim()
}

/** Build a clean ModelSelection from an untrusted RPC payload. */
function selectionOf(payload) {
  const provider = stringField(payload, 'provider')
  const model = stringField(payload, 'model')
  const effort = payload?.reasoningEffort
  if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === '')) {
    throw fail(CODES.BAD_REQUEST, 'reasoningEffort 必须是非空字符串。')
  }
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort.trim() }),
  }
}

/** Exact workspace match first, then the nearest registered ancestor. */
function findBinding(cwd, bindings) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const target = real(cwd)
  if (bindings[target] !== undefined) return bindings[target]
  let best
  let bestLength = -1
  for (const [dir, binding] of Object.entries(bindings)) {
    const base = real(dir)
    if (target !== base && !target.startsWith(base + path.sep)) continue
    if (base.length > bestLength) {
      best = binding
      bestLength = base.length
    }
  }
  return best
}

/** Resolve the exact workspace a menu action was invoked on. */
function workspaceDir(ctx, request) {
  const workspaceId = stringField(request, 'workspaceId')
  const workspace = ctx.workspaceRegistry.get(workspaceId)
  if (workspace === undefined) {
    throw fail(CODES.WORKSPACE_NOT_FOUND, `找不到工作区 ${workspaceId}。`)
  }
  const dir = real(workspace.path)
  const supplied = request?.path
  if (typeof supplied === 'string' && supplied.trim() !== '' && real(supplied) !== dir) {
    throw fail(CODES.BAD_REQUEST, '工作区路径与当前注册路径不一致。')
  }
  return dir
}

function describeError(error) {
  if (error instanceof PluginError) {
    return { code: error.code, message: error.message, status: HTTP_STATUS[error.code] ?? 400 }
  }
  return { code: CODES.INTERNAL, message: error instanceof Error ? error.message : String(error), status: 500 }
}

/** Services this plugin needs. */
export const inject = ['connection', 'configEditor', 'workspaceRegistry', 'llm', 'agents']

/** Stable Loader/plugin identity. */
export const name = 'workspace-model'

/**
 * Install the Host half.
 *
 * @param {object} ctx host context
 * @param {{ bindings?: Record<string, object> }} config plugin configuration
 */
export function apply(ctx, config = {}) {
  const entry = ctx.fiber.entry
  const editor = ctx.get('configEditor')

  let bindings = config.bindings && typeof config.bindings === 'object' && !Array.isArray(config.bindings)
    ? { ...config.bindings }
    : {}

  async function save(next) {
    if (entry === undefined || editor === undefined) {
      throw fail(CODES.CONFIG_UNAVAILABLE, '当前 profile 无法保存插件配置。')
    }
    await editor.edit(entry, current => ({ ...current, bindings: next }))
    bindings = next
  }

  /** Apply a binding to live Sessions that have not made a model request yet. */
  function applyToBlankSessions(dir, selection) {
    for (const agent of ctx.agents.list()) {
      const cwd = agent.session.header.cwd
      if (cwd === undefined || real(cwd) !== dir) continue
      // A blank Session may carry a recorded default selection. It is still a
      // new conversation until a request/header exists, so the binding wins.
      if (agent.session.requestHeader() !== undefined) continue
      agent.model.select(selection)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    const header = agent.session.header
    // Delegation children keep their explicitly requested model.
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return
    const cwd = header.cwd
    if (cwd === undefined) return
    // This fires for both fresh creates and resumed blank Sessions. A Session
    // with a request/header has already started and keeps its own choice.
    if (agent.session.requestHeader() !== undefined) return
    const selection = findBinding(cwd, bindings)
    if (selection === undefined) return
    agent.model.select({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
  })

  const handlers = {
    get(request) {
      const dir = workspaceDir(ctx, request)
      return { binding: bindings[dir] ?? null }
    },

    async set(request) {
      const dir = workspaceDir(ctx, request)
      const selection = selectionOf(request)
      try {
        await ctx.llm.resolveCallConfig(selection)
      } catch (error) {
        throw fail(CODES.MODEL_UNAVAILABLE, `模型不可用：${error instanceof Error ? error.message : String(error)}`)
      }
      const next = { ...bindings, [dir]: selection }
      await save(next)
      applyToBlankSessions(dir, selection)
      return { binding: selection }
    },

    async clear(request) {
      const dir = workspaceDir(ctx, request)
      const next = { ...bindings }
      delete next[dir]
      await save(next)
      return { binding: null }
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
        return json({ ok: false, error: { code: CODES.BAD_REQUEST, message: `未知的 action：${String(payload.action)}` } }, 400)
      }
      try {
        return json({ ok: true, ...await handler(payload) })
      } catch (error) {
        const described = describeError(error)
        if (described.code === CODES.INTERNAL) ctx.logger?.warn?.(`workspace-model: ${payload.action} failed: ${described.message}`)
        return json({ ok: false, error: { code: described.code, message: described.message } }, described.status)
      }
    },
  }

  let registered = false
  const install = (scope) => {
    if (registered) return
    const connection = scope.get('connection', false)
    if (connection?.fetch?.register === undefined) return
    scope.effect(() => connection.fetch.register(route), 'workspace-model: rpc route')
    registered = true
  }

  install(ctx)
  ctx.inject(['connection'], scope => install(scope))
}
