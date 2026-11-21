window.__ModuleLoader__.load({
  id: '@forward/workspace-model',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const RPC_ROUTE = '/api/forward-workspace-model/rpc'
    const NS = 'workspaceModel'

    const ZH = {
      'meta.title': '工作区模型',
      'meta.description': '在工作区的右键或省略号菜单中直接显示并切换该工作区的模型。工作区首次创建会话时会固定当前默认模型，之后会话内临时切换模型不会影响该工作区；新建的会话会使用工作区绑定的模型。',
      chooseModel: '选择模型',
      pickerTitle: '工作区模型',
      searchPlaceholder: '搜索模型',
      empty: '暂无可用模型',
      noResults: '没有匹配的模型',
      loading: '正在加载模型…',
      current: '当前',
      inherited: '继承默认',
      clear: '清除绑定',
      saving: '保存中…',
      saved: '已保存工作区模型',
      loadFailed: '模型目录加载失败',
      saveFailed: '保存失败',
      close: '关闭',
    }

    const EN = {
      'meta.title': 'Workspace model',
      'meta.description': 'Shows and changes the model of a workspace from its right-click or ellipsis menu. The current default is pinned to a workspace when its first session is created; after that, temporary model switches inside a session do not change the workspace, and new sessions start on the workspace model.',
      chooseModel: 'Choose model',
      pickerTitle: 'Workspace model',
      searchPlaceholder: 'Search models',
      empty: 'No models available',
      noResults: 'No matching models',
      loading: 'Loading models…',
      current: 'Current',
      inherited: 'Inherited default',
      clear: 'Clear binding',
      saving: 'Saving…',
      saved: 'Workspace model saved',
      loadFailed: 'Could not load the model catalog',
      saveFailed: 'Could not save',
      close: 'Close',
    }

    /** Minimal shared snapshot store for the menu -> overlay handoff. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        set(next) {
          if (Object.is(value, next)) return
          value = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      const [value, setValue] = useState(store.getSnapshot)
      useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [store])
      return value
    }

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
        throw new RpcError(data?.error?.code ?? 'E_RPC', data?.error?.message ?? `HTTP ${response.status}`)
      }
      return data
    }

    async function loadCatalog(ctx) {
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.value
    }

    /** Composer-style label: prefer the catalog name, fall back to ids. */
    function modelLabel(catalog, selection) {
      if (!selection?.provider || !selection?.model) return undefined
      for (const group of catalog?.groups ?? []) {
        if (group.id !== selection.provider) continue
        const model = (group.models ?? []).find(item => item.id === selection.model)
        if (model?.name) return model.name
      }
      return `${selection.provider}/${selection.model}`
    }

    function MenuIcon() {
      return h('svg', {
        viewBox: '0 0 36 36', width: 16, height: 16, 'aria-hidden': true,
        style: { display: 'block', fill: 'none', stroke: 'var(--dsw-alias-brand-primary, #2563eb)', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      },
        h('rect', { x: 5, y: 10, width: 26, height: 18, rx: 3 }),
        h('path', { d: 'M5 16h26' }),
        h('circle', { cx: 23, cy: 23, r: 2.5 }),
      )
    }

    //chrome mirrors the host ModelSelect model pane (ModelSelect.module.css):
    // elevated menu surface, compact search, 34px radio rows, trailing check.
    const backdropStyle = {
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'var(--dsw-alias-bg-mask-2)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 12,
    }

    const panelStyle = {
      boxSizing: 'border-box',
      minWidth: 'min(240px, calc(100vw - 24px))',
      width: 360,
      maxWidth: 'min(420px, calc(100vw - 24px))',
      maxHeight: 'min(360px, calc(100dvh - 96px))',
      display: 'flex', flexDirection: 'column',
      padding: 4,
      border: 0,
      borderRadius: 'var(--dsw-radius-md)',
      '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
      boxShadow: 'var(--dsw-elevation-prominent)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      overflow: 'hidden',
      '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
      '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
    }

    const searchRowStyle = {
      position: 'relative', flexShrink: 0, margin: '2px 0 3px',
      display: 'flex', alignItems: 'center',
      padding: '5px 7px', border: '0 solid transparent',
      borderRadius: 'var(--dsw-radius-md)', background: 'transparent',
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: 0,
      border: 0, outline: 'none', background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12, lineHeight: 'normal',
    }

    const statusStyle = {
      padding: '8px', color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 12, lineHeight: '18px',
    }

    const groupStyle = {
      position: 'sticky', top: 0, zIndex: 1,
      padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px',
    }

    const groupsStyle = {
      minHeight: 0, overflowX: 'hidden', overflowY: 'auto', flex: 1,
    }

    const rowStyle = {
      boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6,
      width: 'auto', minWidth: '100%', minHeight: 34,
      padding: '5px 7px', border: 0, borderRadius: 'var(--dsw-radius-md)',
      outline: 'none', background: 'transparent', color: 'inherit',
      textAlign: 'left', cursor: 'pointer', fontSize: 13, lineHeight: '18px',
    }

    function Picker({ store, rpc: callRpc, loadCatalog: load, t, ctx }) {
      const request = useStore(store)
      const [catalog, setCatalog] = useState(null)
      const [catalogStatus, setCatalogStatus] = useState('loading')
      const [currentSelection, setCurrentSelection] = useState(null)
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [activeIndex, setActiveIndex] = useState(0)
      const inputRef = useRef(null)
      const dialogRef = useRef(null)

      useEffect(() => {
        if (request === null) return undefined
        let cancelled = false
        setQuery('')
        setError('')
        setCatalogStatus('loading')
        setCurrentSelection(null)
        Promise.all([
          load(),
          callRpc('get', { workspaceId: request.workspaceId, path: request.path }),
        ]).then(([value, binding]) => {
          if (cancelled) return
          setCatalog(value)
          setCurrentSelection(binding.binding ?? value.default ?? null)
          setCatalogStatus('ready')
        }).catch(() => {
          if (!cancelled) setCatalogStatus('error')
        })
        return () => { cancelled = true }
      }, [request?.workspaceId, request?.nonce, load])

      useEffect(() => {
        if (request === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            store.set(null)
            return
          }
          if (event.key === 'Tab' && dialogRef.current !== null) {
            const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled])')]
            if (focusable.length === 0) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [request, activeIndex])

      useEffect(() => {
        if (request !== null && inputRef.current) inputRef.current.focus()
      }, [request])

      if (request === null) return null

      const close = () => store.set(null)
      const groups = catalog?.groups ?? []
      const needle = query.trim().toLowerCase()
      const shown = groups.map(group => ({
        ...group,
        models: (group.models ?? []).filter(model =>
          needle === '' || String(model.name ?? '').toLowerCase().includes(needle) || String(model.id ?? '').toLowerCase().includes(needle)),
      })).filter(group => group.models.length > 0)
      const flat = shown.flatMap(group => group.models.map(model => ({ provider: group.id, model })))
      const active = flat.length === 0 ? undefined : flat[Math.min(activeIndex, flat.length - 1)]

      const choose = async (provider, model) => {
        setBusy(true)
        setError('')
        try {
          await callRpc('set', { workspaceId: request.workspaceId, path: request.path, provider, model })
          ctx.contextMenus.notify(t('saved'), true)
          close()
        } catch (e) {
          setError(`${t('saveFailed')}: ${String(e?.message ?? e)}`)
        } finally {
          setBusy(false)
        }
      }

      const onSearchKeyDown = (event) => {
        if (flat.length === 0) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex(index => (index + 1) % flat.length)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex(index => (index - 1 + flat.length) % flat.length)
        } else if (event.key === 'Enter' && active !== undefined) {
          event.preventDefault()
          void choose(active.provider, active.model.id)
        }
      }

      const clear = async () => {
        setBusy(true)
        setError('')
        try {
          await callRpc('clear', { workspaceId: request.workspaceId, path: request.path })
          ctx.contextMenus.notify(t('saved'), true)
          close()
        } catch (e) {
          setError(`${t('saveFailed')}: ${String(e?.message ?? e)}`)
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        style: backdropStyle,
        onMouseDown: event => { if (event.target === event.currentTarget) close() },
      }, h('div', {
        ref: dialogRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('pickerTitle'),
        style: panelStyle,
      },
        h('div', { style: searchRowStyle },
          h('input', {
            ref: inputRef,
            type: 'text',
            role: 'searchbox',
            value: query,
            onChange: event => { setQuery(event.target.value); setActiveIndex(0) },
            onKeyDown: onSearchKeyDown,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            style: inputStyle,
          }),
          query !== ''
            ? h('button', {
              type: 'button', onClick: () => { setQuery(''); setActiveIndex(0); inputRef.current?.focus() },
              'aria-label': t('close'),
              style: { border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 14, padding: '0 4px' },
            }, '×')
            : null,
        ),
        catalogStatus === 'loading' ? h('div', { style: statusStyle }, t('loading')) : null,
        catalogStatus === 'error' ? h('div', { style: statusStyle }, t('loadFailed')) : null,
        error ? h('div', { role: 'alert', style: { ...statusStyle, color: 'var(--dsw-alias-label-secondary)' } }, error) : null,
        h('div', { style: groupsStyle, role: 'menu', 'aria-label': t('pickerTitle') },
          shown.length === 0
            ? (catalogStatus === 'ready'
              ? h('div', { role: 'status', style: statusStyle }, needle === '' ? t('empty') : t('noResults'))
              : null)
            : shown.map(group => h('div', { key: group.id },
              h('div', { style: groupStyle }, group.name || group.id),
              group.models.map(model => {
                const index = flat.findIndex(entry => entry.provider === group.id && entry.model.id === model.id)
                const selected = currentSelection?.provider === group.id && currentSelection?.model === model.id
                return h('button', {
                  key: `${group.id}/${model.id}`,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': selected ? 'true' : 'false',
                  tabIndex: index === activeIndex ? 0 : -1,
                  title: model.name || model.id,
                  disabled: busy,
                  onFocus: () => setActiveIndex(index),
                  onClick: () => choose(group.id, model.id),
                  style: {
                    ...rowStyle,
                    background: index === activeIndex ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                  },
                  onMouseMove: () => { if (index !== activeIndex) setActiveIndex(index) },
                },
                  h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, model.name || model.id),
                  h('span', { style: { display: 'grid', placeItems: 'center', flex: '0 0 14px', color: 'var(--dsw-alias-label-primary)' } }, selected ? '✓' : ''),
                )
              }),
            )),
        ),
        busy
          ? h('div', { style: statusStyle }, t('saving'))
          : h('div', {},
            h('div', { style: { height: 1, margin: '4px 2px', background: 'var(--dsw-alias-border-l1)' } }),
            h('button', {
              type: 'button', onClick: clear,
              style: { ...rowStyle, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
            }, t('clear')),
          ),
      ))
    }

    return {
      inject: ['contextMenus', 'slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'workspace-model: dictionaries')
        const t = ctx.locale.bind(NS)
        const store = createStore(null)
        let catalogCache = null
        let catalogCacheAt = 0
        const load = async () => {
          const now = Date.now()
          if (catalogCache !== null && now - catalogCacheAt < 30000) return catalogCache
          const value = await loadCatalog(ctx)
          catalogCache = value
          catalogCacheAt = now
          return value
        }

        ctx.effect(() => ctx.contextMenus.register({
          id: 'workspace-model.select',
          target: 'workspace',
          order: 200,
          resolve: async (target, signal) => {
            let label = t('chooseModel')
            try {
              const [bindingResponse, catalog] = await Promise.all([
                rpc('get', { workspaceId: target.workspaceId, path: target.path }, signal),
                load(),
              ])
              label = modelLabel(catalog, bindingResponse.binding ?? catalog.default) ?? t('chooseModel')
            } catch {
              // Keep the generic label when Host data is temporarily unavailable.
            }
            return [{
              id: 'select',
              label,
              icon: { key: 'workspace-model.model' },
              run: () => {
                store.set({
                  workspaceId: target.workspaceId,
                  path: target.path,
                  displayTitle: target.displayTitle,
                  nonce: Date.now(),
                })
              },
            }]
          },
        }), 'workspace-model: workspace model menu')

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon', key: 'workspace-model.model',
        }, MenuIcon))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-model.picker',
          inject: () => ({ store, rpc, loadCatalog: load, t, ctx }),
        }, Picker))
      },
    }
  },
})
