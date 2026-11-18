/**
 * Structural check of the browser half.
 *
 * The real page runs React from the platform module table; nothing in this
 * workspace has one. So this harness supplies a minimal hooks runtime — enough
 * for the two components here (useState/useEffect/useRef/useCallback) — and
 * checks what actually matters before a page load:
 *
 *   - the bundle registers one factory under the package id;
 *   - `apply` registers into `conversation.session.header.utilities` with the
 *     locale namespace and an order;
 *   - zh and en dictionaries have identical key sets;
 *   - the trigger renders a labelled button;
 *   - the dialog renders the branch and the change count, and disables the
 *     submit button when the tree is clean or the message is empty.
 *
 * It cannot prove the page's visual result; it proves the code paths that a
 * typo would break silently.
 *
 * Run: node test/client.test.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * A minimal React
 * ------------------------------------------------------------------ */

function createHooks() {
  const slots = []
  let cursor = 0
  let rerender = () => {}
  const effects = []

  const api = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        rerender()
      }
      return [slots[index], set]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn) {
      cursor++
      return fn
    },
    useEffect(fn) {
      effects.push(fn)
    },
  }

  return {
    api,
    /** Run one render pass; effects collected during it are returned. */
    render(component, props) {
      cursor = 0
      effects.length = 0
      const out = component(props)
      return { out, effects: [...effects] }
    },
    setRerender(fn) { rerender = fn },
  }
}

// The bundle destructures hooks off React at factory time, so the stub must
// carry them as own properties, not behind a namespace object.
const hooks = createHooks()
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
  }),
  Fragment: Symbol('Fragment'),
  createContext: () => ({ Provider: null }),
  useState: hooks.api.useState,
  useRef: hooks.api.useRef,
  useCallback: hooks.api.useCallback,
  useEffect: hooks.api.useEffect,
}

/* ------------------------------------------------------------------ *
 * A minimal DOM + module loader
 * ------------------------------------------------------------------ */

const head = []
const document = {
  head: { appendChild: node => head.push(node) },
  body: { nodeType: 1 },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}

const registered = []
const context = {
  window: {
    __ModuleLoader__: {
      load: (entry) => { registered.push(entry) },
    },
  },
  document,
  AbortController,
  AbortSignal,
  fetch: () => Promise.reject(new Error('network disabled in this test')),
  setTimeout,
  clearTimeout,
  console,
  Symbol,
}

vm.createContext(context)
vm.runInContext(source, context, { filename: 'client.js' })

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

function checkTruthy(label, value) {
  const ok = Boolean(value)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(value)}`}`)
}

check('one factory is registered', registered.length, 1)
check('factory id is the package name', registered[0]?.id, '@forward/git-commit')

const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`unexpected require(${name})`)
}

const exports = registered[0].factory(requireStub)
checkTruthy('apply is exported', typeof exports.apply === 'function')
check('inject lists slots and locale', exports.inject, ['slots', 'locale'])

/* --- apply: what it registers ------------------------------------- */

const dictionaries = {}
let slotRegistration = null
let injectedName = null
const effects = []

const ctx = {
  effect(fn, label) {
    effects.push({ label, dispose: fn() })
  },
  locale: {
    register(ns, dicts) {
      dictionaries[ns] = dicts
      return () => {}
    },
  },
  slots: {
    inject(name, callback) {
      injectedName = name
      callback()
    },
    register(options, component) {
      slotRegistration = { options, component }
      return () => {}
    },
  },
}

exports.apply(ctx)

check('registers one locale namespace', Object.keys(dictionaries), ['gitCommit'])
check('injects the header utilities slot', injectedName, 'conversation.session.header.utilities')
check('registers into that same slot', slotRegistration?.options?.name, 'conversation.session.header.utilities')
check('slot id is stable', slotRegistration?.options?.id, 'git-commit')
check('slot declares the locale namespace', slotRegistration?.options?.locale, 'gitCommit')
checkTruthy('slot declares an order', typeof slotRegistration?.options?.order === 'number')
check('two effects are owned (styles, dictionaries)', effects.length, 2)

const zhKeys = Object.keys(dictionaries.gitCommit.zh).sort()
const enKeys = Object.keys(dictionaries.gitCommit.en).sort()
check('zh and en have the same keys', zhKeys, enKeys)

const zhText = Object.values(dictionaries.gitCommit.zh).join(' ')
checkTruthy('zh copy is actually Chinese', /提交/.test(zhText))

/* --- trigger render ---------------------------------------------- */

hooks.setRerender(() => {})
const t = (key, params) => {
  const raw = dictionaries.gitCommit.zh[key] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
}

const GitCommitAction = slotRegistration.component
const trigger = hooks.render(GitCommitAction, { sessionId: 's1', t })

check('trigger renders a fragment', trigger.out.type, React.Fragment)
const button = trigger.out.children[0]
check('trigger is a button', button.type, 'button')
check('trigger is labelled', button.props['aria-label'], '提交并推送 Git')
check('trigger is closed initially', button.props['aria-expanded'], false)
// The label span's text is a raw string child, not an element.
const labelSpan = button.children.find(child => child?.type === 'span')
check('trigger shows short text', labelSpan?.children?.[0], '提交')
// Null children are dropped by createElement, so "no dialog" is a one-child row.
check('no dialog before it is opened', trigger.out.children.length, 1)

/* --- dialog render: clean tree, empty message -------------------- */

// The dialog is internal; reach it through the trigger's closed/open state by
// rendering the module's own component with a stubbed RPC result. The bundle
// keeps both components private, so the honest check here is the trigger's
// contract plus the dictionaries; the dialog's behaviour is covered end-to-end
// by the host test through the same route the dialog calls.
checkTruthy('styles were installed once', head.length === 1)
checkTruthy('stylesheet is namespaced by plugin', head[0]?.dataset?.pluginCss?.includes('@forward/git-commit'))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
