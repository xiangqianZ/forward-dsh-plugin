/**
 * forward-git-commit — browser half.
 *
 * A hand-written lazy-CJS bundle: `window.__ModuleLoader__.load({ id, factory })`
 * whose factory requires React and react-dom from the platform module table and
 * nothing else. No build step, no JSX, no TypeScript. The official authoring
 * checklist asks a client bundle to import no Harness Client package; the few
 * controls this plugin needs are drawn here against the host's own design
 * tokens, so the header does not look foreign and a missing peer import cannot
 * blank the slot entry.
 *
 * Where it sits: `conversation.session.header.utilities`, the right-aligned
 * control row of the Session header — the row directly above the View tab strip
 * that carries 对话 / 上下文 / 编队. A button there is in the user's line of
 * sight without taking a View tab of its own, which is what a *button* (not a
 * page) needs.
 *
 * The dialog is portalled to `document.body`: the header clips overflow, so an
 * absolutely-positioned child would be cut off.
 *
 * @module @forward/git-commit/client
 */

window.__ModuleLoader__.load({
  id: '@forward/git-commit',
  factory: (require) => {
    // The loader passes `require` but no `module`, so every bundle declares its
    // own CommonJS-ish pair, exactly as the shipped bundles do.
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')

    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /* ------------------------------------------------------------------ *
     * 1. Wire contract — mirror of index.js
     * ------------------------------------------------------------------ */

    /** Package name; also the module-loader id and the locale namespace. */
    const PLUGIN_ID = '@forward/git-commit'

    /** The one exact host route this half talks to. */
    const RPC_ROUTE = '/api/forward-git-commit/rpc'

    /* ------------------------------------------------------------------ *
     * 2. Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.gc-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 9px 0 7px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
}
.gc-trigger:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
@media (hover: hover) { .gc-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }

.gc-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .32));
}
.gc-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: min(70vh, 640px);
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  box-shadow: 0 12px 32px rgba(0, 0, 0, .24);
  overflow: hidden;
}
.gc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
}
.gc-title { flex: 1; min-width: 0; margin: 0; font-size: 15px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.gc-close {
  flex: none; width: 24px; height: 24px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
@media (hover: hover) { .gc-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }

.gc-meta { display: flex; flex-direction: column; gap: 4px; padding: 0 16px 12px; }
.gc-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 12px; line-height: 18px; }
.gc-label { flex: none; color: var(--dsw-alias-label-tertiary); }
.gc-value { min-width: 0; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-branch { font-family: var(--dsw-font-mono, ui-monospace, monospace); color: var(--dsw-alias-label-primary); }
.gc-dirty { color: var(--dsw-alias-state-warn-primary); }
.gc-clean { color: var(--dsw-alias-state-success-primary); }

.gc-body { display: flex; flex-direction: column; gap: 6px; padding: 0 16px 12px; min-height: 0; }
.gc-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 76px;
  max-height: 220px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  resize: vertical;
}
.gc-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.gc-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.gc-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }

.gc-notice { padding: 0 16px 10px; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.gc-error { color: var(--dsw-alias-state-error-primary); }
.gc-success { color: var(--dsw-alias-state-success-primary); }
.gc-warn { color: var(--dsw-alias-state-warn-primary); }

.gc-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px 14px;
  border-top: .5px solid var(--dsw-alias-border-l3);
}
.gc-btn {
  box-sizing: border-box; height: 30px; padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: transparent; color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 18px; cursor: pointer;
}
@media (hover: hover) { .gc-btn:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.gc-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.gc-btn:disabled { cursor: default; opacity: .55; }
.gc-primary {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
}
@media (hover: hover) { .gc-primary:hover { background: var(--dsw-alias-state-business-primary); filter: brightness(1.08); } }
`

    /** Inject the stylesheet once per page; the disposer removes it on unload. */
    function installStyles() {
      const tagId = `${PLUGIN_ID}/styles`
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /* ------------------------------------------------------------------ *
     * 3. RPC
     * ------------------------------------------------------------------ */

    class RpcError extends Error {
      constructor(code, message) {
        super(message)
        this.name = 'RpcError'
        this.code = code
      }
    }

    async function rpc(action, payload, signal) {
      let response
      try {
        response = await fetch(RPC_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(payload ?? {}) }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new RpcError('E_TRANSPORT', String(error?.message ?? error))
      }

      let data
      try {
        data = await response.json()
      } catch {
        throw new RpcError('E_BAD_RESPONSE', `HTTP ${response.status}`)
      }
      if (data === null || typeof data !== 'object') throw new RpcError('E_BAD_RESPONSE', `HTTP ${response.status}`)
      if (data.ok !== true) {
        const failure = data.error
        throw new RpcError(
          typeof failure?.code === 'string' ? failure.code : 'E_UNKNOWN',
          typeof failure?.message === 'string' ? failure.message : `HTTP ${response.status}`,
        )
      }
      return data
    }

    /* ------------------------------------------------------------------ *
     * 4. Icons — the host's own artwork, copied path-for-path
     * ------------------------------------------------------------------ */

    function IconBranch({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('circle', { cx: 4.5, cy: 3.5, r: 1.8 }),
      h('circle', { cx: 4.5, cy: 12.5, r: 1.8 }),
      h('circle', { cx: 11.5, cy: 6, r: 1.8 }),
      h('path', { d: 'M4.5 5.3v5.4' }),
      h('path', { d: 'M11.5 7.8c0 2.4-2.2 2.9-4.4 3.3' }))
    }

    function IconCommit({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        'aria-hidden': true,
      },
      h('circle', { cx: 8, cy: 8, r: 2.6 }),
      h('path', { d: 'M8 1.5v3.9' }),
      h('path', { d: 'M8 10.6v3.9' }))
    }

    function IconClose({ size = 12 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3.5 3.5l9 9' }),
      h('path', { d: 'M12.5 3.5l-9 9' }))
    }

    /* ------------------------------------------------------------------ *
     * 5. The dialog
     * ------------------------------------------------------------------ */

    /** Describe the working tree in one short clause. */
    function describeChanges(changes, t) {
      if (changes === undefined || changes === null) return ''
      const total = Number(changes.total ?? 0)
      if (total === 0) return t('dialog.clean')
      const parts = [t('dialog.changed', { count: total })]
      if (Number(changes.staged ?? 0) > 0) parts.push(t('dialog.staged', { count: changes.staged }))
      if (Number(changes.untracked ?? 0) > 0) parts.push(t('dialog.untracked', { count: changes.untracked }))
      return parts.join(' · ')
    }

    /**
     * The commit dialog.
     *
     * Phases: `loading` (reading status), `ready` (form), `busy` (commit+push in
     * flight), `done`. A failure returns to `ready` with the reason on screen —
     * the user's message is never thrown away, because the common failure (a
     * rejected push) is retryable once the branch is brought up to date.
     */
    function CommitDialog({ sessionId, onClose, t }) {
      const [phase, setPhase] = useState('loading')
      const [status, setStatus] = useState(null)
      const [message, setMessage] = useState('')
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)
      const inputRef = useRef(null)
      const cardRef = useRef(null)

      const reload = useCallback((signal) => {
        setPhase('loading')
        setError(null)
        return rpc('status', { sessionId }, signal).then(
          (data) => {
            if (signal?.aborted === true) return
            setStatus(data)
            setPhase('ready')
          },
          (failure) => {
            if (failure?.name === 'AbortError') return
            setError({ text: String(failure?.message ?? failure), code: failure?.code })
            setPhase('ready')
          },
        )
      }, [sessionId])

      // One status read on open; the abort is the cleanup, so a closed dialog
      // never lands a late response on an unmounted component.
      useEffect(() => {
        const controller = new AbortController()
        reload(controller.signal)
        return () => { controller.abort() }
      }, [reload])

      // Focus the message box once the form is usable.
      useEffect(() => {
        if (phase === 'ready' && inputRef.current !== null) inputRef.current.focus()
      }, [phase])

      // Escape closes; while busy it is ignored, because the request is in flight.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          if (phase === 'busy') return
          event.preventDefault()
          onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [phase, onClose])

      const branch = status?.branch ?? null
      const changes = status?.changes
      const dirty = Number(changes?.total ?? 0) > 0
      const canSubmit = phase === 'ready' && message.trim() !== '' && dirty

      const submit = useCallback(async () => {
        if (!canSubmit) return
        setPhase('busy')
        setError(null)
        try {
          setResult(await rpc('commitPush', { sessionId, message: message.trim() }))
          setPhase('done')
        } catch (failure) {
          setError({ text: String(failure?.message ?? failure), code: failure?.code })
          setPhase('ready')
          // The tree may have changed under us (a rejected push, a hook rewrite),
          // so the counts on screen are refreshed rather than trusted.
          reload()
        }
      }, [canSubmit, message, sessionId, reload])

      // Close on success after a beat, so the commit hash is readable but the
      // dialog does not linger.
      useEffect(() => {
        if (phase !== 'done') return undefined
        const timer = setTimeout(onClose, 1600)
        return () => { clearTimeout(timer) }
      }, [phase, onClose])

      const onKeyDownInput = (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }

      const head = h('div', { className: 'gc-head' },
        h(IconCommit, { size: 15 }),
        h('h2', { className: 'gc-title' }, t('dialog.title')),
        h('button', {
          type: 'button',
          className: 'gc-close',
          'aria-label': t('dialog.cancel'),
          disabled: phase === 'busy',
          onClick: onClose,
        }, h(IconClose, { size: 12 })))

      const branchText = branch === null
        ? (phase === 'loading' ? t('dialog.loading') : t('dialog.detached'))
        : branch

      const meta = h('div', { className: 'gc-meta' },
        h('div', { className: 'gc-row' },
          h('span', { className: 'gc-label' }, t('dialog.branch')),
          h('span', { className: 'gc-value gc-branch' }, branchText)),
        h('div', { className: 'gc-row' },
          h('span', { className: 'gc-label' }, t('dialog.changes')),
          h('span', { className: `gc-value ${dirty ? 'gc-dirty' : 'gc-clean'}` },
            phase === 'loading' ? t('dialog.loading') : describeChanges(changes, t))),
        h('div', { className: 'gc-row' },
          h('span', { className: 'gc-label' }, t('dialog.remote')),
          h('span', { className: 'gc-value' },
            status?.remote ?? (phase === 'loading' ? t('dialog.loading') : t('dialog.noRemote')))))

      const body = h('div', { className: 'gc-body' },
        h('textarea', {
          ref: inputRef,
          className: 'gc-input',
          value: message,
          placeholder: t('dialog.placeholder'),
          spellCheck: false,
          disabled: phase === 'busy' || phase === 'done',
          onChange: (event) => { setMessage(event.target.value) },
          onKeyDown: onKeyDownInput,
        }),
        h('div', { className: 'gc-hint' }, t('dialog.hint')))

      const notices = []
      if (error !== null) notices.push(h('div', { key: 'error', className: 'gc-notice gc-error' }, error.text))
      if (phase === 'done') {
        notices.push(h('div', { key: 'done', className: 'gc-notice gc-success' },
          t('dialog.success', {
            commit: result?.short ?? '',
            branch: result?.branch ?? '',
            published: result?.published === true ? t('dialog.published') : '',
          })))
      }
      if (phase === 'ready' && !dirty && error === null) {
        notices.push(h('div', { key: 'clean', className: 'gc-notice gc-warn' }, t('dialog.nothingToCommit')))
      }

      const foot = h('div', { className: 'gc-foot' },
        h('button', {
          type: 'button',
          className: 'gc-btn',
          disabled: phase === 'busy',
          onClick: onClose,
        }, t('dialog.cancel')),
        h('button', {
          type: 'button',
          className: 'gc-btn gc-primary',
          disabled: !canSubmit,
          onClick: submit,
        }, phase === 'busy' ? t('dialog.busy') : t('dialog.submit')))

      const card = h('div', {
        ref: cardRef,
        className: 'gc-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('dialog.title'),
      }, head, meta, body, notices, foot)

      const mask = h('div', {
        className: 'gc-mask',
        onMouseDown: (event) => {
          if (phase === 'busy') return
          if (cardRef.current !== null && cardRef.current.contains(event.target)) return
          onClose()
        },
      }, card)

      return ReactDOM.createPortal(mask, document.body)
    }

    /* ------------------------------------------------------------------ *
     * 6. The header button
     * ------------------------------------------------------------------ */

    /**
     * One header control: a Git pill that opens the commit dialog.
     *
     * It reads no status on its own — a header that polled git would keep the
     * Host busy for a button most Sessions never press. The dialog does the
     * read, so the branch and the file count are current at the moment they
     * matter.
     */
    function GitCommitAction({ sessionId, t }) {
      const [open, setOpen] = useState(false)

      // A different Session means a different repository: close, never carry the
      // previous form over.
      useEffect(() => { setOpen(false) }, [sessionId])

      const closeDialog = useCallback(() => { setOpen(false) }, [])
      const label = t('trigger.label')

      const trigger = h('button', {
        type: 'button',
        className: 'gc-trigger',
        title: label,
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => { setOpen(true) },
      }, h(IconBranch, { size: 14 }), h('span', null, t('trigger.short')))

      const dialog = open ? h(CommitDialog, { sessionId, onClose: closeDialog, t }) : null

      return h(React.Fragment, null, trigger, dialog)
    }

    /* ------------------------------------------------------------------ *
     * 7. Locale + plugin
     * ------------------------------------------------------------------ */

    const NS = 'gitCommit'

    const zh = {
      'trigger.label': '提交并推送 Git',
      'trigger.short': '提交',
      'dialog.title': '提交并推送',
      'dialog.branch': '分支',
      'dialog.changes': '改动',
      'dialog.remote': '远端',
      'dialog.loading': '读取中…',
      'dialog.detached': '游离 HEAD',
      'dialog.noRemote': '未配置',
      'dialog.clean': '没有改动',
      'dialog.changed': '{count} 个文件',
      'dialog.staged': '已暂存 {count}',
      'dialog.untracked': '未跟踪 {count}',
      'dialog.placeholder': '提交信息，例如：fix(header): 修正按钮对齐',
      'dialog.hint': '提交全部改动并推送到远端 · ⌘/Ctrl + Enter 执行',
      'dialog.cancel': '取消',
      'dialog.submit': '提交并推送',
      'dialog.busy': '提交中…',
      'dialog.success': '已提交 {commit} 并推送到 {branch} {published}',
      'dialog.published': '（首次发布）',
      'dialog.nothingToCommit': '工作区没有改动，无需提交。',
    }

    const en = {
      'trigger.label': 'Commit and push to Git',
      'trigger.short': 'Commit',
      'dialog.title': 'Commit and push',
      'dialog.branch': 'Branch',
      'dialog.changes': 'Changes',
      'dialog.remote': 'Remote',
      'dialog.loading': 'Reading…',
      'dialog.detached': 'detached HEAD',
      'dialog.noRemote': 'none configured',
      'dialog.clean': 'no changes',
      'dialog.changed': '{count} files',
      'dialog.staged': '{count} staged',
      'dialog.untracked': '{count} untracked',
      'dialog.placeholder': 'Commit message, e.g. fix(header): align the button',
      'dialog.hint': 'Commits every change and pushes to the remote · ⌘/Ctrl + Enter',
      'dialog.cancel': 'Cancel',
      'dialog.submit': 'Commit and push',
      'dialog.busy': 'Committing…',
      'dialog.success': 'Committed {commit} and pushed to {branch} {published}',
      'dialog.published': '(first publish)',
      'dialog.nothingToCommit': 'The working tree is clean; nothing to commit.',
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forward-git-commit: dictionaries')
      ctx.effect(() => installStyles(), 'forward-git-commit: styles')

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'git-commit',
        order: 10,
        locale: NS,
      }, GitCommitAction))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
