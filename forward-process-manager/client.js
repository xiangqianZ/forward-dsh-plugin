/**
 * forward-process-manager — browser half.
 *
 * Deliberately imperative: the slot contributes one plain button, and clicking
 * it creates a single DOM panel directly under document.body. No React portal,
 * no popover state, no outside-click auto-dismiss — those were the pieces that
 * could make the panel flash and vanish in a live composer. Clicking the same
 * trigger again toggles the panel off; the X button and Escape still work too.
 *
 * @module @forward/process-manager/client
 */

window.__ModuleLoader__.load({
  id: '@forward/process-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useRef = React.useRef

    const PLUGIN_ID = '@forward/process-manager'
    const RPC_ROUTE = '/api/forward-process-manager/rpc'
    const NS = 'projectProcesses'
    const PANEL_ID = 'ppd-panel-root'
    const REFRESH_MS = 5000
    // Head + footer + about three process rows; anything taller scrolls inside.
    // The panel itself is content-sized, this is only the ceiling.
    const PANEL_MAX_HEIGHT = 236

    const ZH = {
      'trigger.label': '当前项目进程',
      'trigger.short': '进程',
      'panel.title': '当前项目进程',
      'panel.subtitle': '工作区：{cwd}',
      'panel.refresh': '刷新',
      'panel.close': '关闭',
      'panel.loading': '读取中…',
      'panel.empty': '没有发现属于当前项目的进程。',
      'panel.truncated': '仅显示前 {count} 个进程。',
      'row.pid': 'PID {pid}',
      'row.cwd': '目录 {cwd}',
      'row.stop': '停止',
      'row.stopping': '停止中…',
      'row.stopped': '已停止进程',
      'error.load': '读取进程失败：{message}',
      'error.stop': '停止失败：{message}',
      'code.E_BAD_REQUEST': '请求参数不正确。',
      'code.E_NO_WORKSPACE': '当前会话没有可用的工作区目录。',
      'code.E_NO_PS': '本机找不到 ps 命令。',
      'code.E_LIST_FAILED': '读取进程列表失败。',
      'code.E_NOT_FOUND': '进程已结束或不在当前项目列表中。',
      'code.E_NO_KILL': '本机找不到 kill 命令。',
      'code.E_KILL_FAILED': '停止信号发送失败。',
      'code.E_INTERNAL': '内部错误。',
    }

    const EN = {
      'trigger.label': 'Project processes',
      'trigger.short': 'Processes',
      'panel.title': 'Project processes',
      'panel.subtitle': 'Workspace: {cwd}',
      'panel.refresh': 'Refresh',
      'panel.close': 'Close',
      'panel.loading': 'Reading…',
      'panel.empty': 'No processes belonging to this project were found.',
      'panel.truncated': 'Showing only the first {count} processes.',
      'row.pid': 'PID {pid}',
      'row.cwd': 'cwd {cwd}',
      'row.stop': 'Stop',
      'row.stopping': 'Stopping…',
      'row.stopped': 'Process stopped',
      'error.load': 'Could not list processes: {message}',
      'error.stop': 'Could not stop the process: {message}',
      'code.E_BAD_REQUEST': 'The request was invalid.',
      'code.E_NO_WORKSPACE': 'This session has no workspace directory.',
      'code.E_NO_PS': 'The ps command is not available on this machine.',
      'code.E_LIST_FAILED': 'Could not read the process list.',
      'code.E_NOT_FOUND': 'The process has exited or is no longer in this project list.',
      'code.E_NO_KILL': 'The kill command is not available on this machine.',
      'code.E_KILL_FAILED': 'Could not send the stop signal.',
      'code.E_INTERNAL': 'An unexpected error occurred.',
    }

    const CSS = `
.ppd-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.ppd-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
@media (hover:hover){.ppd-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.ppd-panel{position:fixed;z-index:2147483000;box-sizing:border-box;display:flex;flex-direction:column;width:min(340px,calc(100vw - 20px));max-height:236px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 12px 32px rgba(0,0,0,.24);overflow:hidden;font-family:inherit}
.ppd-head{display:flex;align-items:center;gap:6px;padding:7px 9px 6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.ppd-heading{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ppd-title{margin:0;font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.ppd-sub{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ppd-iconbtn{flex:none;box-sizing:border-box;width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ppd-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
@media (hover:hover){.ppd-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.ppd-list{flex:1;min-height:0;overflow:auto;padding:6px 0}
.ppd-empty{padding:13px 10px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-align:center}
.ppd-row{display:flex;align-items:center;gap:7px;padding:6px 9px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.ppd-row:last-child{border-bottom:0}
.ppd-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ppd-command{margin:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ppd-meta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ppd-tag{display:inline-block;margin-right:8px;padding:0 5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ppd-actions{flex:none;display:flex;align-items:center;gap:6px}
.ppd-btn{box-sizing:border-box;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.ppd-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.ppd-btn:disabled{cursor:default;opacity:.55}
@media (hover:hover){.ppd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.ppd-foot{flex:none;padding:5px 9px;border-top:.5px solid var(--dsw-alias-border-l3);font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);min-height:24px}
.ppd-foot[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
`

    function installStyles() {
      const selector = `style[data-plugin-css="${PLUGIN_ID}/styles"]`
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/styles`
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    class RpcError extends Error {
      constructor(code, message) {
        super(message)
        this.name = 'RpcError'
        this.code = code
      }
    }

    async function rpc(action, payload) {
      let response
      try {
        response = await fetch(new URL(RPC_ROUTE, document.baseURI).toString(), {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(payload ?? {}) }),
        })
      } catch (error) {
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

    function formatError(prefix, error, t) {
      const code = typeof error?.code === 'string' && error.code.startsWith('E_')
        ? error.code
        : 'E_INTERNAL'
      return t(prefix, { message: t(`code.${code}`) })
    }

    /** Tiny DOM helper: el(tag, props, ...children). */
    function el(tag, props, ...children) {
      const node = document.createElement(tag)
      for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'title') node.title = value
        else if (key === 'style') Object.assign(node.style, value)
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
        } else node.setAttribute(key, value === true ? '' : String(value))
      }
      for (const child of children.flat()) {
        if (child === undefined || child === null || child === false) continue
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
      }
      return node
    }

    function icon(size = 15) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', String(size))
      svg.setAttribute('height', String(size))
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.3')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('aria-hidden', 'true')
      for (const d of ['M2.8 3.2h9.4', 'M2.8 8h6.4', 'M2.8 12.8h9.4', 'M11.4 6.2v3.6']) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
      }
      return svg
    }

    /** Last segment of an absolute directory path, for a short subtitle. */
    function dirName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const trimmed = path.replace(/\/+$/, '')
      const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
      return base !== '' ? base : '/'
    }

    /** The one live panel, shared by both toolbar and dock buttons. */
    let active = null

    function closePanel() {
      if (active === null) return
      if (active.escape !== null) document.removeEventListener('keydown', active.escape)
      if (active.resize !== null) window.removeEventListener('resize', active.resize)
      if (active.reloadTimer !== null) clearTimeout(active.reloadTimer)
      if (active.interval !== null) clearInterval(active.interval)
      active.root.remove()
      active = null
    }

    function place(state) {
      const rect = state.anchor?.getBoundingClientRect?.()
      const width = Math.min(340, window.innerWidth - 20)
      // The panel height follows its content; this ceiling only keeps it on
      // screen on short windows and feeds the flip math below.
      const height = Math.max(100, Math.min(PANEL_MAX_HEIGHT, window.innerHeight - 24))
      let left = 10
      let top = 10
      if (rect !== undefined) {
        left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10))
        // Header buttons sit near the top: open downward from the trigger.
        const below = rect.bottom + 8
        const above = rect.top - height - 8
        if (rect.top < height + 16) {
          top = Math.min(below, Math.max(10, window.innerHeight - height - 10))
        } else {
          top = above >= 10 ? above : Math.max(10, window.innerHeight - height - 10)
        }
        top = Math.max(10, top)
      }
      Object.assign(state.root.style, {
        left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${height}px`,
      })
    }

    function render(state) {
      if (active !== state) return
      const t = state.t
      const root = state.root
      root.replaceChildren()

      const refreshIcon = icon(14)
      const title = el('div', { class: 'ppd-heading' },
        el('h2', { class: 'ppd-title', text: t('panel.title') }),
        // Short workspace name in the subtitle; the full path stays on hover.
        el('p', {
          class: 'ppd-sub',
          text: t('panel.subtitle', { cwd: state.data ? dirName(state.data.cwd) : '…' }),
          title: state.data?.cwd ?? '',
        }))
      const head = el('div', { class: 'ppd-head' }, icon(15), title,
        el('button', {
          class: 'ppd-iconbtn', title: t('panel.refresh'), 'aria-label': t('panel.refresh'),
          onclick: () => { load(state) },
        }, refreshIcon),
        el('button', {
          class: 'ppd-iconbtn', title: t('panel.close'), 'aria-label': t('panel.close'),
          onclick: closePanel,
        }, el('span', { text: '✕' })) )

      const list = el('div', { class: 'ppd-list' })
      const processes = state.data?.processes ?? []
      if (processes.length === 0) {
        list.appendChild(el('div', {
          class: 'ppd-empty',
          text: state.loading && state.data === null ? t('panel.loading') : t('panel.empty'),
        }))
      } else {
        for (const item of processes) {
          const ports = Array.isArray(item.ports) ? item.ports.join(', ') : ''
          const meta = el('p', { class: 'ppd-meta' },
            el('span', { class: 'ppd-tag', text: t('row.pid', { pid: item.pid }) }),
            ports === '' ? null : el('span', { text: `:${ports}` }))
          const actions = el('div', { class: 'ppd-actions' })
          actions.appendChild(el('button', {
            class: 'ppd-btn', disabled: state.busyPid === item.pid,
            title: t('row.stop'),
            onclick: () => {
              if (state.busyPid !== item.pid) stopOne(state, item)
            },
          }, state.busyPid === item.pid ? t('row.stopping') : t('row.stop')))
          list.appendChild(el('div', { class: 'ppd-row' },
            el('div', { class: 'ppd-main' },
              el('p', { class: 'ppd-command', text: item.command, title: item.command }),
              meta),
            actions))
        }
      }

      const footText = state.error !== '' ? state.error
        : state.notice !== '' ? state.notice
          : state.data?.truncated === true ? t('panel.truncated', { count: state.data.total }) : ''
      const foot = el('div', {
        class: 'ppd-foot', 'data-error': state.error !== '' || undefined,
        role: 'status', 'aria-live': 'polite', text: footText,
      })

      root.append(head, list, foot)
    }

    async function stopOne(state, item) {
      state.busyPid = item.pid
      state.error = ''
      state.notice = ''
      render(state)
      try {
        // One click stops the process for good — no second "force quit" step.
        await rpc('stop', { sessionId: state.sessionId, pid: item.pid, force: true })
        state.notice = state.t('row.stopped')
        if (state.reloadTimer !== null) clearTimeout(state.reloadTimer)
        state.reloadTimer = setTimeout(() => {
          state.reloadTimer = null
          load(state)
        }, 900)
      } catch (error) {
        state.error = formatError('error.stop', error, state.t)
      } finally {
        state.busyPid = null
        render(state)
      }
    }

    async function load(state) {
      const seq = state.seq + 1
      state.seq = seq
      state.loading = true
      state.error = ''
      render(state)
      try {
        const result = await rpc('list', { sessionId: state.sessionId })
        if (active !== state || seq !== state.seq) return
        state.data = result
      } catch (error) {
        if (active !== state || seq !== state.seq) return
        state.error = formatError('error.load', error, state.t)
      } finally {
        if (active === state && seq === state.seq) {
          state.loading = false
          render(state)
        }
      }
    }

    function openPanel(sessionId, t, anchor) {
      if (active !== null) {
        place(active)
        load(active)
        return
      }
      const root = el('div', {
        id: PANEL_ID, class: 'ppd-panel', role: 'dialog', 'aria-label': t('panel.title'),
      })
      document.body.appendChild(root)
      const state = {
        root, t, sessionId, anchor, data: null, loading: false,
        busyPid: null, error: '', notice: '', seq: 0,
        escape: null, resize: null, reloadTimer: null, interval: null,
      }
      active = state
      place(state)
      state.escape = (event) => { if (event.key === 'Escape') closePanel() }
      state.resize = () => place(state)
      document.addEventListener('keydown', state.escape)
      window.addEventListener('resize', state.resize)
      state.interval = setInterval(() => { if (active === state) load(state) }, REFRESH_MS)
      load(state)
    }

    /** The slot contribution: one button, no local UI state. */
    function Trigger({ sessionId, t }) {
      const ref = useRef(null)
      return h('button', {
        ref,
        type: 'button',
        class: 'ppd-trigger',
        'aria-label': t('trigger.label'),
        title: t('trigger.label'),
        onClick: () => {
          if (active !== null) closePanel()
          else openPanel(sessionId, t, ref.current)
        },
      }, h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': true,
      },
      h('rect', { x: 1.8, y: 2.2, width: 12.4, height: 11.6, rx: 2.2 }),
      h('path', { d: 'M4.6 5.6h3.2' }),
      h('path', { d: 'M4.6 8.2h6.8' })),
      h('span', null, t('trigger.short')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'forward-process-manager: dictionaries')
        ctx.effect(() => installStyles(), 'forward-process-manager: styles')
        const t = ctx.locale.bind(NS)
        // Top-right Session header utilities, immediately after the 提交
        // (git commit) button whose order is 10.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'project-processes',
          order: 11,
          locale: NS,
        }, (props) => h(Trigger, { ...props, t })))
      },
    }
  },
})
