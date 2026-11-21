/**
 * @forward/copy-file — browser half.
 *
 * A hand-written lazy-CJS bundle, like the other plugins in this repo: no
 * build step, no JSX, no Harness Client package imports. React comes from the
 * platform module table, and every visual element here is a plain element.
 *
 * The only UI is a contribution to the shared right-click menu for the `file`
 * and `directory` targets the Conversation layer already captures. Selecting
 * the action calls the Host route, which writes the real file item to the
 * macOS clipboard. `notify()` gives a short confirmation; a rejection is left
 * to the menu's own failure toast (with our localized failureLabel).
 *
 * @module @forward/copy-file/client
 */

window.__ModuleLoader__.load({
  id: '@forward/copy-file',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const RPC_ROUTE = '/api/forward-copy-file/rpc'
    const NS = 'copyFile'

    const ZH = {
      'meta.title': '复制文件',
      'meta.description': '在对话中的文件路径或目录上右键，直接选「复制文件」，把文件本身放进系统剪贴板，可以马上粘贴到访达或其他位置，不必先打开文件目录。仅支持 macOS。',
      fileLabel: '复制文件',
      folderLabel: '复制文件夹',
      copiedFile: '已复制文件到剪贴板，按 ⌘V 粘贴',
      copiedFolder: '已复制文件夹到剪贴板，按 ⌘V 粘贴',
      copyFailed: '复制失败，请确认文件仍存在（仅支持 macOS）',
    }

    const EN = {
      'meta.title': 'Copy file',
      'meta.description': 'Right-click a file path or folder in the conversation and choose Copy file to put the file itself on the macOS clipboard, ready to paste in Finder or anywhere else. macOS only.',
      fileLabel: 'Copy file',
      folderLabel: 'Copy folder',
      copiedFile: 'File copied to clipboard — press ⌘V to paste',
      copiedFolder: 'Folder copied to clipboard — press ⌘V to paste',
      copyFailed: 'Copy failed. Check that the file still exists (macOS only).',
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
        throw new RpcError(
          typeof data?.error?.code === 'string' ? data.error.code : 'E_RPC',
          typeof data?.error?.message === 'string' ? data.error.message : `HTTP ${response.status}`,
        )
      }
      return data
    }

    /** Two-page glyph at the host menu's 16 px icon box and stroke weight. */
    function CopyIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('rect', { x: 5.4, y: 3.2, width: 7.4, height: 9.6, rx: 1.3 }),
        h('path', { d: 'M10.2 3.2V2.5A1.3 1.3 0 0 0 8.9 1.2H3.9A1.3 1.3 0 0 0 2.6 2.5v8.1a1.3 1.3 0 0 0 1.3 1.3h.7' }),
        h('path', { d: 'M7.4 6.6h3.4M7.4 9.2h3.4' }))
    }

    return {
      inject: ['contextMenus', 'slots', 'locale'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'copy-file: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: 'copy-file.copy',
        }, CopyIcon))

        // The Host writes the clipboard through macOS AppleScript. Only a
        // known non-mac desktop is disabled up front; an unset platform (plain
        // browser) still lets the Host decide with its own platform check.
        const platform = document.documentElement.dataset.platform
        const unsupportedPlatform = platform === 'win32' || platform === 'linux'

        const contribute = (target, id, labelKey, successKey) => ctx.effect(() => ctx.contextMenus.register({
          id: `copy-file.${id}`,
          target,
          order: 150,
          resolve: (value) => [{
            id: 'copy',
            label: t(labelKey),
            icon: { key: 'copy-file.copy' },
            // Built-in open-in-app ends its file menu with "Copy file path";
            // keep this file-item action visually separate from it.
            separatorBefore: true,
            disabled: unsupportedPlatform,
            failureLabel: t('copyFailed'),
            run: async () => {
              try {
                await rpc('copy', { sessionId: value.sessionId, path: value.path })
                ctx.contextMenus.notify(t(successKey), true)
              } catch (error) {
                // The registry only shows failureLabel on a rejection, so pass
                // the host's actual reason through a dismissible notice here.
                const message = typeof error?.message === 'string' && error.message !== ''
                  ? error.message
                  : t('copyFailed')
                ctx.contextMenus.notify(message, false)
              }
            },
          }],
        }), `copy-file: ${id} menu`)

        contribute('file', 'file', 'fileLabel', 'copiedFile')
        contribute('directory', 'directory', 'folderLabel', 'copiedFolder')
      },
    }
  },
})
