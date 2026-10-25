/**
 * dsh-plugin-memo — client half (Web UI, v2)
 *
 * Sidebar entry `sidebar.panellist#memo` + main panel `main#memo`.
 * Slots are declared by other entries, so registration goes through
 * ctx.slots.inject(ownerKey, () => ctx.slots.register(...)): it installs once the
 * parent is ready and disposed when the parent collapses.
 *
 * v2 layout: one "sheet" switch (待办 / 备忘).
 *   待办: two columns — 工作 / 个人.
 *   备忘: two columns — left column has two stacked note windows, right column has
 *         one full-height window. Each window autosaves (600 ms debounce, flush on
 *         blur / sheet switch / unload), so several notes can be written at once.
 *
 * Data lives in the Host half's JSON store, reached over the same-origin HTTP API
 * (see index.js). Styling uses only --dsw-alias-* theme tokens, so light/dark follow
 * the host; all visible text goes through ctx.locale.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-memo',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'memo'
    const NS = 'memo'
    const API = '/notes-todo/api'
    const MAX_TEXT = 2000
    const MAX_MEMO = 20000
    const MEMO_SLOTS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'main']
    const AUTOSAVE_DELAY = 600
    const RIGHT_TAB_ID = 'dsh-plugin-memo:main'
    const RIGHT_TAB_KIND = 'memo:main'
    const MEMO_SYNC_EVENT = 'dsh-plugin-memo:sync'

    const DICTS = {
      en: {
        title: 'Memos',
        tabTodos: 'Todos',
        tabMemos: 'Memos',
        subtitleTodos: 'Open {open} · Done {done}',
        autosaveHint: 'Autosave on',
        saving: 'Saving…',
        savedAt: 'Saved · {time}',
        saveFailed: 'Save failed — keep typing to retry',
        work: 'Work',
        personal: 'Personal',
        todoPlaceholderWork: 'Add a work todo, then Enter',
        todoPlaceholderPersonal: 'Add a personal todo, then Enter',
        add: 'Add',
        clearDone: 'Clear done',
        editHint: 'Click to edit',
        doneSection: 'Done',
        emptyWork: 'No work todos.',
        emptyPersonal: 'No personal todos.',
        emptyDone: 'Nothing done yet.',
        delete: 'Delete',
        markDone: 'Mark done',
        markUndone: 'Mark open',
        memo1: 'Note 1…',
        memo2: 'Note 2…',
        memo3: 'Note 3…',
        memo4: 'Note 4…',
        memoMain: 'Main notes…',
        sideTitle: 'Main memo',
        sideGuide: 'Memo',
        sideGuideDesc: 'Write the main memo while chatting',
        loading: 'Loading…',
        refresh: 'Refresh',
        errorPrefix: 'Something went wrong:',
        retry: 'Retry',
        renderError: 'The panel failed to render; the error was logged.',
      },
      zh: {
        title: '备忘',
        tabTodos: '待办',
        tabMemos: '备忘',
        subtitleTodos: '未完成 {open} · 已完成 {done}',
        autosaveHint: '自动保存已开启',
        saving: '保存中…',
        savedAt: '已自动保存 · {time}',
        saveFailed: '保存失败，继续输入会自动重试',
        work: '工作',
        personal: '个人',
        todoPlaceholderWork: '添加工作待办，回车确认',
        todoPlaceholderPersonal: '添加个人待办，回车确认',
        add: '添加',
        clearDone: '清空已完成',
        editHint: '点击编辑',
        doneSection: '已完成',
        emptyWork: '工作待办是空的。',
        emptyPersonal: '个人待办是空的。',
        emptyDone: '还没有已完成事项。',
        delete: '删除',
        markDone: '标记完成',
        markUndone: '标记未完成',
        memo1: '记录 1…',
        memo2: '记录 2…',
        memo3: '记录 3…',
        memo4: '记录 4…',
        memoMain: '主要备忘…',
        sideTitle: '主要备忘',
        sideGuide: '备忘',
        sideGuideDesc: '边聊天边记大备忘',
        loading: '读取中…',
        refresh: '刷新',
        errorPrefix: '出错了：',
        retry: '重试',
        renderError: '面板渲染出错，已记录日志。',
      },
    }

    /* ---------------- helpers ---------------- */

    function fmt(template, vars) {
      return String(template || '').replace(/\{(\w+)\}/g, (_, key) =>
        vars && vars[key] !== undefined ? String(vars[key]) : '',
      )
    }

    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    function formatClock(ms) {
      const date = new Date(ms)
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    }

    function formatWhen(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const now = new Date()
      const day = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      const datePart = date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}-${day}`
      return `${datePart} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function normalizeMemos(raw) {
      const memos = emptyMemos()
      if (!raw || typeof raw !== 'object') return memos
      for (const slot of MEMO_SLOTS) {
        if (typeof raw[slot] === 'string') memos[slot] = raw[slot]
      }
      // Carry the earlier three-window shape (leftTop/leftBottom/right) over once.
      if (!memos.topLeft && typeof raw.leftTop === 'string') memos.topLeft = raw.leftTop
      if (!memos.bottomLeft && typeof raw.leftBottom === 'string') memos.bottomLeft = raw.leftBottom
      if (!memos.main && typeof raw.right === 'string') memos.main = raw.right
      return memos
    }

    function emptyMemos() {
      const memos = {}
      for (const slot of MEMO_SLOTS) memos[slot] = ''
      return memos
    }

    function emptyMemoStatus() {
      const status = {}
      for (const slot of MEMO_SLOTS) status[slot] = 'idle'
      return status
    }

    async function readJson(res) {
      const text = await res.text()
      if (!text) return undefined
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 120))
      }
    }

    function errorText(data, res) {
      if (data && typeof data.error === 'string' && data.error) return data.error
      return `HTTP ${res.status}`
    }

    function reportClientError(error, info) {
      try {
        fetch(`${API}/client-log`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            level: 'render-error',
            message: String((error && error.message) || error),
            stack: String((error && error.stack) || ''),
            componentStack: info ? String(info.componentStack || '') : '',
          }),
        }).catch(() => {})
      } catch {
        /* reporting must never break the fallback view */
      }
    }

    /* ---------------- styles (theme tokens only) ---------------- */

    const CSS = `
.dnt-page{height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:20px 24px 24px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
.dnt-head{flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dnt-title{margin:0;font-size:18px;font-weight:600;letter-spacing:.01em}
.dnt-sub{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dnt-head-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dnt-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.dnt-tab{font-family:inherit;font-size:12.5px;line-height:1.6;padding:3px 16px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dnt-tab:hover{color:var(--dsw-alias-label-primary)}
.dnt-tab[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600}
.dnt-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;margin-top:14px}
.dnt-board{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dnt-col{min-height:0;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.dnt-col-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dnt-card-title{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px}
.dnt-count{font-weight:400;font-size:11px;line-height:1.5;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dnt-add{display:flex;gap:8px;align-items:flex-start}
.dnt-input{flex:1 1 auto;min-width:0;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;outline:none}
.dnt-edit{flex:1 1 auto;min-width:0;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.6;outline:none}
.dnt-btn{flex:0 0 auto;font-family:inherit;font-size:12px;padding:4px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dnt-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dnt-btn:disabled{opacity:.55;cursor:not-allowed}
.dnt-btn-small{padding:2px 8px;font-size:11.5px}
.dnt-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dnt-btn-primary:hover:not(:disabled){background:transparent;color:var(--dsw-alias-brand-primary)}
.dnt-list{display:flex;flex-direction:column;gap:2px;min-height:0}
.dnt-scroll{flex:1 1 auto;overflow:auto}
.dnt-todo{display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:7px;border:1px solid transparent}
.dnt-todo[draggable="true"]{cursor:grab}
.dnt-todo.dnt-dragging{opacity:.4}
.dnt-drop-before{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary)}
.dnt-drop-after{box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}
.dnt-todo:hover{background:var(--dsw-alias-bg-layer-2)}
.dnt-check{flex:0 0 auto;width:16px;height:16px;margin:2px 0 0;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-bg-base);cursor:pointer}
.dnt-check[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dnt-todo-text{flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word;padding-top:1px;cursor:text}
.dnt-done .dnt-todo-text{color:var(--dsw-alias-label-secondary)}
.dnt-meta{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;padding-top:3px;font-variant-numeric:tabular-nums}
.dnt-row-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .12s}
.dnt-todo:hover .dnt-row-actions,.dnt-row-actions:focus-within{opacity:1}
.dnt-icon-btn{font-family:inherit;font-size:12px;line-height:1.4;padding:1px 4px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dnt-icon-btn:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dnt-empty{margin:0;padding:8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l1);border-radius:8px}
.dnt-section{flex:1 1 0;min-height:0;display:flex;flex-direction:column;gap:4px}
.dnt-section-done{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dnt-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dnt-section-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dnt-pending{margin:0;padding:6px 2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dnt-error{margin:10px 0 0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}
.dnt-memo-grid{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:1fr 1.25fr;gap:12px}
.dnt-memo-left{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px;min-height:0}
.dnt-memo{box-sizing:border-box;width:100%;height:100%;min-height:0;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.7;resize:none;outline:none}
.dnt-btn:focus-visible,.dnt-icon-btn:focus-visible,.dnt-tab:focus-visible,.dnt-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media (max-width:860px){.dnt-board{grid-template-columns:1fr;overflow:auto}.dnt-col{min-height:360px}.dnt-memo-grid{grid-template-columns:1fr;overflow:auto}.dnt-memo{min-height:140px}}
.dnt-side{height:100%;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:10px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dnt-side-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px}
.dnt-side-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dnt-side-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dnt-side-area{flex:1 1 auto;min-height:120px;width:100%;box-sizing:border-box;resize:none;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.7;outline:none}
.dnt-side-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:11px;word-break:break-word}
`

    /* ---------------- data ---------------- */

    function useStore() {
      const [state, setState] = React.useState({
        status: 'loading',
        todos: [],
        memos: emptyMemos(),
        error: null,
        lastSavedAt: null,
      })
      const [memoStatus, setMemoStatus] = React.useState(emptyMemoStatus())

      const seq = React.useRef(0)
      const timers = React.useRef({})
      const latestMemos = React.useRef(state.memos)
      const editedMemos = React.useRef(false)
      const mounted = React.useRef(true)
      const instanceId = React.useRef(`memo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      // The same memo slot can be edited in two mounted surfaces (the Memo panel
      // and the right-sidebar tab). Keystrokes in one mirror into the other; only
      // the surface that owns the edit runs the debounced save.
      React.useEffect(() => {
        const receive = (event) => {
          const detail = event && event.detail
          if (!detail || detail.source === instanceId.current) return
          if (typeof detail.slot !== 'string' || typeof detail.text !== 'string') return
          if (MEMO_SLOTS.indexOf(detail.slot) < 0) return
          if (latestMemos.current[detail.slot] === detail.text) return
          editedMemos.current = true
          latestMemos.current = { ...latestMemos.current, [detail.slot]: detail.text }
          setState((prev) => ({ ...prev, memos: { ...prev.memos, [detail.slot]: detail.text } }))
          setMemoStatus((prev) => ({ ...prev, [detail.slot]: 'saved' }))
        }
        window.addEventListener(MEMO_SYNC_EVENT, receive)
        return () => window.removeEventListener(MEMO_SYNC_EVENT, receive)
      }, [])

      const load = React.useCallback(() => {
        const mine = ++seq.current
        setState((prev) => ({ ...prev, status: 'loading', error: null }))
        fetch(`${API}/state`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await readJson(res)
            if (!res.ok || !data || data.ok !== true) throw new Error(errorText(data, res))
            if (mine !== seq.current) return
            const memos = normalizeMemos(data.memos)
            if (!editedMemos.current) latestMemos.current = memos
            setState((prev) => ({
              ...prev,
              status: 'ok',
              todos: Array.isArray(data.todos) ? data.todos : [],
              memos: editedMemos.current ? prev.memos : memos,
              error: null,
            }))
          })
          .catch((error) => {
            if (mine === seq.current) {
              setState((prev) => ({ ...prev, status: 'error', error: String((error && error.message) || error) }))
            }
          })
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const mutateTodo = React.useCallback((op, payload) => {
        const mine = ++seq.current
        return fetch(`${API}/mutate`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ op, ...(payload || {}) }),
        })
          .then(async (res) => {
            const data = await readJson(res)
            if (!res.ok || !data || data.ok !== true) throw new Error(errorText(data, res))
            if (mine === seq.current) {
              setState((prev) => ({
                ...prev,
                status: 'ok',
                todos: Array.isArray(data.todos) ? data.todos : prev.todos,
                error: null,
              }))
            }
            return true
          })
          .catch((error) => {
            if (mine === seq.current) {
              setState((prev) => ({ ...prev, error: String((error && error.message) || error) }))
            }
            return false
          })
      }, [])

      const saveMemo = React.useCallback((slot) => {
        const text = latestMemos.current[slot]
        setMemoStatus((prev) => ({ ...prev, [slot]: 'saving' }))
        return fetch(`${API}/mutate`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ op: 'memo.set', slot, text }),
        })
          .then(async (res) => {
            const data = await readJson(res)
            if (!res.ok || !data || data.ok !== true) throw new Error(errorText(data, res))
            if (!mounted.current) return true
            setMemoStatus((prev) => ({
              ...prev,
              [slot]: latestMemos.current[slot] === text ? 'saved' : prev[slot],
            }))
            setState((prev) => ({ ...prev, lastSavedAt: Date.now(), error: null }))
            return true
          })
          .catch((error) => {
            if (mounted.current) {
              setMemoStatus((prev) => ({ ...prev, [slot]: 'error' }))
              setState((prev) => ({ ...prev, error: String((error && error.message) || error) }))
            }
            return false
          })
      }, [])

      const updateMemo = React.useCallback(
        (slot, text) => {
          editedMemos.current = true
          latestMemos.current = { ...latestMemos.current, [slot]: text }
          setState((prev) => ({ ...prev, memos: { ...prev.memos, [slot]: text } }))
          setMemoStatus((prev) => ({ ...prev, [slot]: 'saving' }))
          if (timers.current[slot]) clearTimeout(timers.current[slot])
          timers.current[slot] = setTimeout(() => {
            timers.current[slot] = null
            saveMemo(slot)
          }, AUTOSAVE_DELAY)
          try {
            window.dispatchEvent(
              new CustomEvent(MEMO_SYNC_EVENT, {
                detail: { source: instanceId.current, slot, text },
              }),
            )
          } catch {
            /* cross-surface sync is best effort */
          }
        },
        [saveMemo],
      )

      const flushMemo = React.useCallback(
        (slot) => {
          if (!timers.current[slot]) return
          clearTimeout(timers.current[slot])
          timers.current[slot] = null
          saveMemo(slot)
        },
        [saveMemo],
      )

      // Save any pending edit when the panel unmounts (the network call is best effort).
      React.useEffect(
        () => () => {
          for (const slot of MEMO_SLOTS) {
            if (timers.current[slot]) {
              clearTimeout(timers.current[slot])
              timers.current[slot] = null
              saveMemo(slot)
            }
          }
        },
        [saveMemo],
      )

      // A reload or app close inside the debounce window must not lose the last edit.
      React.useEffect(() => {
        const flushBeacon = () => {
          for (const slot of MEMO_SLOTS) {
            if (!timers.current[slot]) continue
            clearTimeout(timers.current[slot])
            timers.current[slot] = null
            try {
              const body = JSON.stringify({ op: 'memo.set', slot, text: latestMemos.current[slot] })
              if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
                navigator.sendBeacon(`${API}/mutate`, new Blob([body], { type: 'application/json' }))
              }
            } catch {
              /* best effort */
            }
          }
        }
        window.addEventListener('beforeunload', flushBeacon)
        return () => window.removeEventListener('beforeunload', flushBeacon)
      }, [])

      return { ...state, memoStatus, load, mutateTodo, updateMemo, flushMemo }
    }

    function useLocaleRevision(locale) {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
      return revision
    }

    /* ---------------- small components ---------------- */

    function CheckGlyph() {
      return h(
        'svg',
        { width: 10, height: 10, viewBox: '0 0 12 12', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M1.8 6.3l2.6 2.6 5.6-6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function TodoRow(props) {
      const { todo, t, section } = props
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(todo.text)
      const cancelled = React.useRef(false)

      const startEdit = () => {
        cancelled.current = false
        setDraft(todo.text)
        setEditing(true)
      }

      const finishEdit = () => {
        if (cancelled.current) {
          cancelled.current = false
          setEditing(false)
          return
        }
        const next = draft.trim()
        setEditing(false)
        if (next && next !== todo.text) props.onEdit(todo, next)
      }

      const dragging = props.drag && props.drag.id === todo.id
      const canDrop =
        props.drag && props.drag.section === section && props.drag.category === todo.category && props.drag.id !== todo.id
      const drop =
        canDrop && props.over && props.over.id === todo.id
          ? props.over.after
            ? 'dnt-drop-after'
            : 'dnt-drop-before'
          : ''
      const className = ['dnt-todo', todo.done ? 'dnt-done' : '', dragging ? 'dnt-dragging' : '', drop]
        .filter(Boolean)
        .join(' ')

      return h(
        'div',
        {
          className,
          draggable: !editing,
          onDragStart: (event) => {
            if (editing) {
              event.preventDefault()
              return
            }
            try {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', todo.id)
            } catch {
              /* some environments restrict dataTransfer */
            }
            props.onDragStart(todo, section)
          },
          onDragOver: (event) => {
            if (!canDrop) return
            event.preventDefault()
            try {
              event.dataTransfer.dropEffect = 'move'
            } catch {
              /* ignore */
            }
            const rect = event.currentTarget.getBoundingClientRect()
            props.onDragOver(todo, event.clientY > rect.top + rect.height / 2)
          },
          onDrop: (event) => {
            if (!canDrop) return
            event.preventDefault()
            props.onDrop()
          },
          onDragEnd: () => props.onDragEnd(),
        },
        h(
          'button',
          {
            type: 'button',
            role: 'checkbox',
            className: 'dnt-check',
            'aria-checked': todo.done,
            title: todo.done ? t('markUndone') : t('markDone'),
            onClick: () => props.onToggle(todo),
          },
          todo.done ? h(CheckGlyph, null) : null,
        ),
        editing
          ? h('input', {
              className: 'dnt-edit',
              type: 'text',
              autoFocus: true,
              value: draft,
              maxLength: MAX_TEXT,
              'aria-label': t('editHint'),
              onChange: (event) => setDraft(event.target.value),
              onFocus: (event) => {
                const el = event.currentTarget
                el.setSelectionRange(el.value.length, el.value.length)
              },
              onBlur: finishEdit,
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  cancelled.current = true
                  event.currentTarget.blur()
                }
              },
            })
          : h(
              'span',
              {
                className: 'dnt-todo-text',
                title: t('editHint'),
                onClick: startEdit,
              },
              todo.text,
            ),
        h(
          'span',
          { className: 'dnt-meta', title: (todo.done && todo.doneAt) || todo.createdAt || '' },
          formatWhen((todo.done && todo.doneAt) || todo.createdAt),
        ),
        h(
          'div',
          { className: 'dnt-row-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dnt-icon-btn',
              title: t('delete'),
              'aria-label': t('delete'),
              onClick: () => props.onDelete(todo),
            },
            '×',
          ),
        ),
      )
    }

    function TodoBoard(props) {
      const { t } = props
      const [drafts, setDrafts] = React.useState({ work: '', personal: '' })
      const [busy, setBusy] = React.useState({ work: false, personal: false })
      const [drag, setDrag] = React.useState(null) // { id, section }
      const [over, setOver] = React.useState(null) // { id, after }

      const add = (category) => {
        const text = drafts[category].trim()
        if (!text || busy[category]) return
        setBusy((prev) => ({ ...prev, [category]: true }))
        props.onAdd(category, text).then((ok) => {
          setBusy((prev) => ({ ...prev, [category]: false }))
          if (ok) setDrafts((prev) => ({ ...prev, [category]: '' }))
        })
      }

      const handleDragStart = (todo, section) => {
        setDrag({ id: todo.id, section, category: todo.category })
        setOver(null)
      }

      const handleDragOver = (todo, after) => {
        setOver((prev) =>
          prev && prev.id === todo.id && prev.after === after ? prev : { id: todo.id, after },
        )
      }

      const handleDrop = (target, sectionItems) => {
        const currentDrag = drag
        const currentOver = over
        setDrag(null)
        setOver(null)
        if (!currentDrag || !currentOver || currentDrag.id === target.id) return
        const index = sectionItems.findIndex((item) => item.id === target.id)
        if (index < 0) return
        // Dropping on the lower half of a row means "after that row".
        const beforeId = currentOver.after
          ? index + 1 < sectionItems.length
            ? sectionItems[index + 1].id
            : null
          : target.id
        if (beforeId === currentDrag.id) return
        props.onMove(currentDrag.id, beforeId)
      }

      const handleDragEnd = () => {
        setDrag(null)
        setOver(null)
      }

      const column = (category, label, placeholder, emptyText) => {
        const items = props.todos.filter((todo) => todo.category === category)
        const openItems = items.filter((todo) => !todo.done)
        const doneItems = items.filter((todo) => todo.done)
        const pending = props.loading && !items.length

        const list = (listItems, section) =>
          h(
            'div',
            { className: 'dnt-list dnt-scroll' },
            listItems.map((todo) =>
              h(TodoRow, {
                key: todo.id,
                todo,
                t,
                section,
                drag,
                over,
                onDragStart: handleDragStart,
                onDragOver: handleDragOver,
                onDrop: () => handleDrop(todo, listItems),
                onDragEnd: handleDragEnd,
                onToggle: props.onToggle,
                onDelete: props.onDelete,
                onEdit: props.onEdit,
              }),
            ),
          )

        const openBody = pending
          ? h('p', { className: 'dnt-pending' }, t('loading'))
          : openItems.length
            ? list(openItems, 'open')
            : h('p', { className: 'dnt-empty' }, emptyText)

        const doneBody = pending
          ? null
          : doneItems.length
            ? list(doneItems, 'done')
            : h('p', { className: 'dnt-empty' }, t('emptyDone'))

        return h(
          'section',
          { className: 'dnt-col', 'aria-label': label },
          h(
            'div',
            { className: 'dnt-col-head' },
            h(
              'div',
              { className: 'dnt-card-title' },
              label,
              h('span', { className: 'dnt-count' }, String(openItems.length)),
            ),
          ),
          h(
            'div',
            { className: 'dnt-add' },
            h('input', {
              className: 'dnt-input',
              type: 'text',
              value: drafts[category],
              maxLength: MAX_TEXT,
              placeholder,
              'aria-label': placeholder,
              onChange: (event) => setDrafts((prev) => ({ ...prev, [category]: event.target.value })),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  add(category)
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dnt-btn dnt-btn-primary',
                disabled: busy[category] || !drafts[category].trim(),
                onClick: () => add(category),
              },
              t('add'),
            ),
          ),
          h('div', { className: 'dnt-section' }, openBody),
          h(
            'div',
            { className: 'dnt-section dnt-section-done' },
            h(
              'div',
              { className: 'dnt-section-head' },
              h(
                'div',
                { className: 'dnt-section-title' },
                t('doneSection'),
                h('span', { className: 'dnt-count' }, String(doneItems.length)),
              ),
              doneItems.length
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dnt-btn dnt-btn-small',
                      onClick: () => props.onClear(category),
                    },
                    t('clearDone'),
                  )
                : null,
            ),
            doneBody,
          ),
        )
      }

      return h(
        'div',
        { className: 'dnt-board' },
        column('work', t('work'), t('todoPlaceholderWork'), t('emptyWork')),
        column('personal', t('personal'), t('todoPlaceholderPersonal'), t('emptyPersonal')),
      )
    }

    function memoStatusLabel(t, store) {
      const states = MEMO_SLOTS.map((slot) => store.memoStatus[slot])
      if (states.indexOf('error') >= 0) return t('saveFailed')
      if (states.indexOf('saving') >= 0) return t('saving')
      if (store.lastSavedAt) return fmt(t('savedAt'), { time: formatClock(store.lastSavedAt) })
      return t('autosaveHint')
    }

    function MemoBoard(props) {
      const { t, memos, onChange, onFlush } = props
      const area = (slot, placeholder, extraClass) =>
        h('textarea', {
          className: 'dnt-memo' + (extraClass ? ` ${extraClass}` : ''),
          value: memos[slot],
          placeholder,
          'aria-label': placeholder,
          maxLength: MAX_MEMO,
          spellCheck: false,
          onChange: (event) => onChange(slot, event.target.value),
          onBlur: () => onFlush(slot),
        })
      return h(
        'div',
        { className: 'dnt-memo-grid' },
        h(
          'div',
          { className: 'dnt-memo-left' },
          area('topLeft', t('memo1')),
          area('topRight', t('memo2')),
          area('bottomLeft', t('memo3')),
          area('bottomRight', t('memo4')),
        ),
        area('main', t('memoMain'), 'dnt-memo-main'),
      )
    }

    /**
     * Right-sidebar tab body: the big "main" memo window, so a memo can be
     * written while the conversation fills the center column. It shares the
     * Host store with the panel; edits mirror across mounted surfaces through
     * MEMO_SYNC_EVENT and autosave exactly like the panel editor.
     */
    function MemoSidebarBody(props) {
      const t = props.t
      useLocaleRevision(props.locale)
      const store = useStore()
      const status = memoStatusLabel(t, store)

      return h(
        'div',
        { className: 'dnt-side' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dnt-side-head' },
          h('span', { className: 'dnt-side-title' }, t('sideTitle')),
          h('span', { className: 'dnt-side-sub', title: status }, status),
        ),
        h('textarea', {
          className: 'dnt-side-area',
          value: store.memos.main,
          placeholder: t('memoMain'),
          'aria-label': t('sideTitle'),
          maxLength: MAX_MEMO,
          spellCheck: false,
          onChange: (event) => store.updateMemo('main', event.target.value),
          onBlur: () => store.flushMemo('main'),
        }),
        store.error
          ? h('p', { className: 'dnt-side-error' }, `${t('errorPrefix')} ${store.error}`)
          : null,
      )
    }

    function ErrorCard(props) {
      const t = props.t
      return h(
        'div',
        { className: 'dnt-page' },
        h('h1', { className: 'dnt-title' }, t ? t('title') : 'Memos'),
        h('p', { className: 'dnt-sub' }, t ? t('renderError') : 'The panel failed to render; the error was logged.'),
        h('pre', { className: 'dnt-error', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, String(props.message || '')),
      )
    }

    const PanelBoundary = (() => {
      const Base = React && React.Component
      if (typeof Base !== 'function') return null
      return class PanelBoundary extends Base {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error }
        }
        componentDidCatch(error, info) {
          reportClientError(error, info)
        }
        render() {
          if (this.state.error) {
            return h(ErrorCard, {
              message: String((this.state.error && this.state.error.message) || this.state.error),
              t: this.props.t,
            })
          }
          return this.props.children
        }
      }
    })()

    function withBoundary(Component) {
      if (!PanelBoundary) return Component
      return function PanelWithBoundary(props) {
        return h(PanelBoundary, props, h(Component, props))
      }
    }

    /* ---------------- panel ---------------- */

    function Panel(props) {
      const { t, locale } = props
      useLocaleRevision(locale)
      const store = useStore()

      const [view, setView] = React.useState('todos')

      const todos = store.todos
      const openCount = todos.filter((todo) => !todo.done).length
      const doneCount = todos.length - openCount

      const switching = (next) => {
        if (next === view) return
        for (const slot of MEMO_SLOTS) store.flushMemo(slot)
        setView(next)
      }

      const memoSubtitle = memoStatusLabel(t, store)

      const subtitle =
        store.status === 'loading'
          ? t('loading')
          : view === 'todos'
            ? fmt(t('subtitleTodos'), { open: openCount, done: doneCount })
            : memoSubtitle

      const tab = (id, label) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'dnt-tab',
            'aria-pressed': view === id,
            onClick: () => switching(id),
          },
          label,
        )

      return h(
        'div',
        { className: 'dnt-page' },
        h('style', { key: 'style' }, CSS),
        h(
          'header',
          { className: 'dnt-head' },
          h(
            'div',
            { className: 'dnt-head-text' },
            h('h1', { className: 'dnt-title' }, t('title')),
            h('p', { className: 'dnt-sub' }, subtitle),
          ),
          h(
            'div',
            { className: 'dnt-head-right' },
            h(
              'div',
              { className: 'dnt-tabs', role: 'group', 'aria-label': t('title') },
              tab('todos', t('tabTodos')),
              tab('memos', t('tabMemos')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dnt-btn',
                disabled: store.status === 'loading',
                onClick: () => store.load(),
              },
              t('refresh'),
            ),
          ),
        ),
        store.error
          ? h(
              'div',
              { className: 'dnt-error' },
              `${t('errorPrefix')} ${store.error}`,
              h(
                'button',
                { type: 'button', className: 'dnt-btn dnt-btn-small', style: { marginLeft: '8px' }, onClick: () => store.load() },
                t('retry'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dnt-body' },
          view === 'todos'
            ? h(TodoBoard, {
                t,
                todos,
                loading: store.status === 'loading',
                onAdd: (category, text) => store.mutateTodo('todo.add', { text, category }),
                onToggle: (todo) => store.mutateTodo('todo.toggle', { id: todo.id, done: !todo.done }),
                onDelete: (todo) => store.mutateTodo('todo.delete', { id: todo.id }),
                onClear: (category) => store.mutateTodo('todo.clearCompleted', { category }),
                onMove: (id, beforeId) => store.mutateTodo('todo.move', { id, beforeId }),
                onEdit: (todo, text) => store.mutateTodo('todo.update', { id: todo.id, text }),
              })
            : h(MemoBoard, {
                t,
                memos: store.memos,
                onChange: store.updateMemo,
                onFlush: store.flushMemo,
              }),
        ),
      )
    }

    /* ---------------- sidebar icon ---------------- */

    function MemoIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 4.2, y: 3, width: 15.6, height: 18, rx: 2.4 }),
        h('path', { d: 'M8.2 8.4h7.6M8.2 12h7.6' }),
        h('path', { d: 'M8.2 15.7l1.7 1.7 3.8-4.3' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en))
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh))
        const t = ctx.locale.bind(NS)
        const locale = ctx.locale

        // Sidebar entry: its id must match the main panel key, so the sidebar's
        // click resolves to this panel.
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('title') },
              MemoIcon,
            ),
          ),
        )

        // Main panel: keyed slot, key = sidebar entry id.
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID },
              withBoundary((panelProps) => h(Panel, { ...panelProps, t, locale })),
            ),
          ),
        )

        // Right sidebar: the big "main" memo window as its own tab type, so a
        // memo can be written beside the conversation. The guide card is the
        // entry point; once opened, the per-session layout remembers the tab.
        ctx.inject(['sidebarRightTabs'], (sidebarCtx) => {
          const sidebarTabs = sidebarCtx.get('sidebarRightTabs')
          if (!sidebarTabs || typeof sidebarTabs.register !== 'function') return
          sidebarCtx.effect(() =>
            sidebarTabs.register({
              id: RIGHT_TAB_ID,
              kind: RIGHT_TAB_KIND,
              priority: 'extension',
              keepMounted: true,
              title: () => t('sideGuide'),
              guide: [
                {
                  id: 'main',
                  order: 60,
                  title: () => t('sideGuide'),
                  description: t('sideGuideDesc'),
                  icon: MemoIcon,
                },
              ],
            }),
          )
          sidebarCtx.effect(() =>
            sidebarCtx.slots.inject('sidebar.right.pane.tab', () =>
              sidebarCtx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: RIGHT_TAB_ID,
                  inject: () => ({ t, locale }),
                },
                MemoSidebarBody,
              ),
            ),
          )
        })
      },
    }
  },
})
