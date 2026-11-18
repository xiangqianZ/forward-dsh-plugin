/**
 * End-to-end check of the host half against a real git repository.
 *
 * Builds a throwaway repo with a bare "remote", then drives the plugin's route
 * exactly as the browser would: `status`, then `commitPush`. Verifies the commit
 * landed, the push landed on the remote, and the failure paths report the right
 * codes instead of throwing.
 *
 * Run: node test/e2e.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, RPC_ROUTE } from '../index.js'

/* ------------------------------------------------------------------ *
 * A minimal `ctx` with just enough of the Host to run the plugin.
 * ------------------------------------------------------------------ */

/** Spawn through node's child_process, shaped like ctx.subprocess. */
function createSubprocess() {
  return {
    async resolveExecutable(name) {
      return name
    },
    spawn({ argv, cwd, stdio, env }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (stdio.stdin !== 'ignore' && stdio.stdin?.data !== undefined) child.stdin.end(stdio.stdin.data)
      else child.stdin.end()

      const chunks = { stdout: [], stderr: [] }
      child.stdout.on('data', chunk => chunks.stdout.push(chunk))
      child.stderr.on('data', chunk => chunks.stderr.push(chunk))

      const done = new Promise((resolve) => {
        child.on('close', (exitCode) => resolve({ exitCode, signal: null }))
      })

      const read = (name) => ({ text: Buffer.concat(chunks[name]).toString('utf8') })
      return {
        done,
        collected: {
          stdout: { readFrom: () => read('stdout') },
          stderr: { readFrom: () => read('stderr') },
        },
      }
    },
  }
}

/** A Host context with one Session whose cwd is `cwd`. */
function createContext(cwd) {
  const effects = []
  const routes = new Map()
  const services = {
    subprocess: createSubprocess(),
    sessions: { get: id => (id === 'test-session' ? { header: { cwd } } : undefined) },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  // Cordis exposes every registered service as a context property as well as
  // through `get`, so the fake must do both.
  const ctx = {
    ...services,
    logger: { warn: message => console.error('[warn]', message) },
    get: (name, fallback) => services[name] ?? fallback,
    effect(fn) { effects.push(fn()); return fn },
    inject(names, callback) {
      if (names.every(name => services[name] !== undefined)) callback(ctx)
    },
    routes,
  }
  return ctx
}

/** Call the registered route the way the browser does. */
async function call(ctx, body) {
  const route = ctx.routes.get(RPC_ROUTE)
  if (route === undefined) throw new Error('route not registered')
  const response = await route.fetch(new Request(`http://127.0.0.1${RPC_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

/** Run git in a directory and fail loudly on error. */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')}: ${err.trim()}`))))
  })
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

function checkTruthy(label, value) {
  const ok = Boolean(value)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(value)}`}`)
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const root = await mkdtemp(join(tmpdir(), 'forward-git-commit-'))
const remoteDir = join(root, 'remote.git')
const workDir = join(root, 'work')

try {
  await mkdir(workDir)
  await git(root, ['init', '--bare', '-q', remoteDir])
  await git(workDir, ['init', '-q'])
  await git(workDir, ['config', 'user.email', 'test@example.com'])
  await git(workDir, ['config', 'user.name', 'Test'])
  await git(workDir, ['remote', 'add', 'origin', remoteDir])
  // The default branch name depends on the machine's init.defaultBranch; pin it
  // so the assertions below name one branch instead of guessing.
  await git(workDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

  const ctx = createContext(workDir)
  apply(ctx)

  checkTruthy('route registered on connection.fetch', ctx.routes.has(RPC_ROUTE))

  // 1. An empty repository: no branch yet, no changes.
  let result = await call(ctx, { action: 'status', sessionId: 'test-session' })
  check('status ok on empty repo', result.body.ok, true)
  // An unborn branch still has a symbolic ref, so it is reported by name rather
  // than mistaken for a detached HEAD (which would refuse the first commit).
  check('unborn branch is named', result.body.branch, 'main')
  check('no changes before the first commit', result.body.changes.total, 0)

  // 2. A real change, then the one-click path.
  await writeFile(join(workDir, 'a.txt'), 'hello\n')
  await writeFile(join(workDir, 'b.txt'), 'world\n')

  result = await call(ctx, { action: 'status', sessionId: 'test-session' })
  check('untracked files are counted', result.body.changes.total, 2)
  check('untracked files are flagged', result.body.changes.untracked, 2)
  check('origin is the chosen remote', result.body.remote, 'origin')

  result = await call(ctx, { action: 'commitPush', sessionId: 'test-session', message: 'feat: first commit' })
  check('commitPush ok', result.body.ok, true)
  check('commit subject round-trips', result.body.subject, 'feat: first commit')
  check('branch is reported', result.body.branch, 'main')
  check('first push publishes the branch', result.body.published, true)
  checkTruthy('commit hash is returned', typeof result.body.short === 'string' && result.body.short.length >= 7)

  check('commit exists locally', await git(workDir, ['log', '-1', '--pretty=%s']), 'feat: first commit')
  check('commit reached the remote', await git(remoteDir, ['log', '-1', '--pretty=%s', 'main']), 'feat: first commit')

  // 3. Second change: the branch now has an upstream, so the push is a plain one.
  await writeFile(join(workDir, 'a.txt'), 'hello again\n')
  result = await call(ctx, { action: 'commitPush', sessionId: 'test-session', message: 'fix: second' })
  check('second commitPush ok', result.body.ok, true)
  check('second push is not a publish', result.body.published, false)
  check('second commit reached the remote', await git(remoteDir, ['log', '-1', '--pretty=%s', 'main']), 'fix: second')

  // 4. Nothing to commit: refused before git runs, with a coded message.
  result = await call(ctx, { action: 'commitPush', sessionId: 'test-session', message: 'chore: empty' })
  check('empty tree is refused', result.body.ok, false)
  check('empty tree carries a code', result.body.error.code, 'E_NOTHING_TO_COMMIT')
  check('empty tree is a 409', result.status, 409)

  // 5. An empty message is refused before any git work.
  result = await call(ctx, { action: 'commitPush', sessionId: 'test-session', message: '   ' })
  check('empty message is refused', result.body.error.code, 'E_EMPTY_MESSAGE')

  // 6. A rejected push: the remote moves ahead, then we try to push.
  const otherDir = join(root, 'other')
  await git(root, ['clone', '-q', remoteDir, otherDir])
  await git(otherDir, ['config', 'user.email', 'other@example.com'])
  await git(otherDir, ['config', 'user.name', 'Other'])
  await writeFile(join(otherDir, 'c.txt'), 'theirs\n')
  await git(otherDir, ['add', '-A'])
  await git(otherDir, ['commit', '-q', '-m', 'theirs'])
  await git(otherDir, ['push', '-q', 'origin', 'main'])

  await writeFile(join(workDir, 'a.txt'), 'mine\n')
  result = await call(ctx, { action: 'commitPush', sessionId: 'test-session', message: 'feat: mine' })
  check('rejected push is an error', result.body.ok, false)
  check('rejected push carries E_PUSH_REJECTED', result.body.error.code, 'E_PUSH_REJECTED')
  checkTruthy('rejected push says the commit already landed', /提交已创建/.test(result.body.error.message))

  // 7. A directory that is not a repository.
  const plainDir = join(root, 'plain')
  await mkdir(plainDir)
  const plainCtx = createContext(plainDir)
  apply(plainCtx)
  result = await call(plainCtx, { action: 'status', sessionId: 'test-session' })
  check('non-repository is refused', result.body.error.code, 'E_NO_REPO')

  // 8. An unknown Session.
  result = await call(ctx, { action: 'status', sessionId: 'nope' })
  check('unknown session is refused', result.body.error.code, 'E_NO_WORKSPACE')

  // 9. An unknown action.
  result = await call(ctx, { action: 'nonsense', sessionId: 'test-session' })
  check('unknown action is refused', result.status, 400)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
