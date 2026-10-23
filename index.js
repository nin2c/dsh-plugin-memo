/**
 * dsh-plugin-memo — host half (v2: 备忘 + 待办按工作/个人分栏 + 三格多窗口备忘)
 *
 * storage: one JSON document on this machine
 *   default: $DSH_HOME/plugin-data/notes-todo/data.json
 *   ($DSH_HOME defaults to ~/.dsh; the directory name is kept from v1 so an
 *    existing install keeps its data)
 *
 * Data document (version 2):
 *   {
 *     version: 2,
 *     todos: [{ id, text, done, category: 'work' | 'personal', createdAt, doneAt }],
 *     memos: { topLeft, topRight, bottomLeft, bottomRight, main },  // five windows
 *     updatedAt: ISO string | null
 *   }
 * Version-1 data (notes[] list + todos without category) is migrated on read:
 * category defaults to 'work', note texts move into the memo windows.
 *
 * HTTP API (same origin as the GUI):
 *   GET  /notes-todo/api/ping   -> { ok, plugin, version, dataFile, counts, updatedAt }
 *   GET  /notes-todo/api/state  -> { ok, todos, memos, updatedAt }
 *   POST /notes-todo/api/mutate -> one atomic operation, returns { ok, todos, memos, updatedAt }
 *        body: { op: 'todo.add' | 'todo.toggle' | 'todo.update' | 'todo.delete'
 *                     | 'todo.clearCompleted' | 'memo.set', ...payload }
 *   POST /notes-todo/api/client-log -> appends one JSON line to client.log (panel crash reports)
 *
 * Writes are serialized and atomic (temp file + rename), so a memo autosave and a
 * second browser action cannot interleave a read-modify-write.
 */
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'memo'
export const inject = ['webServer']

const BASE = '/notes-todo'
const VERSION = '0.2.4'
const MAX_BODY = 256 * 1024
const MAX_TEXT = 2000
const MAX_MEMO = 20000
const CATEGORIES = ['work', 'personal']
const MEMO_SLOTS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'main']

const DATA_DIR = (() => {
  const home = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'notes-todo')
})()
const DATA_FILE = path.join(DATA_DIR, 'data.json')

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status })
const nowIso = () => new Date().toISOString()

const emptyMemos = () => ({ topLeft: '', topRight: '', bottomLeft: '', bottomRight: '', main: '' })
const emptyState = () => ({ version: 2, todos: [], memos: emptyMemos(), updatedAt: null })

/** Keep only the fields the UI and future tools rely on; tolerate hand-edited files. */
function normalize(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  if (typeof raw.updatedAt === 'string') state.updatedAt = raw.updatedAt

  if (Array.isArray(raw.todos)) {
    for (const item of raw.todos) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.id !== 'string' || typeof item.text !== 'string') continue
      state.todos.push({
        id: item.id,
        text: item.text,
        done: item.done === true,
        category: CATEGORIES.includes(item.category) ? item.category : 'work',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
        doneAt: typeof item.doneAt === 'string' ? item.doneAt : null,
      })
    }
  }

  if (raw.memos && typeof raw.memos === 'object') {
    for (const slot of MEMO_SLOTS) {
      if (typeof raw.memos[slot] === 'string') state.memos[slot] = raw.memos[slot]
    }
    // Carry the earlier three-window shape (leftTop/leftBottom/right) over once.
    if (!state.memos.topLeft && typeof raw.memos.leftTop === 'string') state.memos.topLeft = raw.memos.leftTop
    if (!state.memos.bottomLeft && typeof raw.memos.leftBottom === 'string') state.memos.bottomLeft = raw.memos.leftBottom
    if (!state.memos.main && typeof raw.memos.right === 'string') state.memos.main = raw.memos.right
    return state
  }

  // Version 1 had a flat `notes` list; move those texts into the memo windows.
  if (Array.isArray(raw.notes)) {
    const texts = raw.notes
      .filter((item) => item && typeof item.text === 'string' && item.text.trim())
      .map((item) => item.text)
    if (texts.length) {
      state.memos.topLeft = texts[0] || ''
      state.memos.topRight = texts[1] || ''
      state.memos.bottomLeft = texts[2] || ''
      state.memos.bottomRight = texts[3] || ''
      state.memos.main = texts.slice(4).join('\n\n')
    }
  }
  return state
}

class Store {
  constructor(file) {
    this.file = file
    this.dir = path.dirname(file)
    this.queue = Promise.resolve()
  }

  /** Serialize every read-modify-write; a failed operation does not poison the queue. */
  exclusive(operation) {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async read() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyState()
      throw error
    }
    try {
      return normalize(JSON.parse(raw))
    } catch {
      // Never silently overwrite a corrupt file: keep a copy for inspection, start empty.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        await copyFile(this.file, backup)
      } catch {
        /* best effort */
      }
      return emptyState()
    }
  }

  async write(state) {
    await mkdir(this.dir, { recursive: true })
    const temp = `${this.file}.tmp`
    const next = { ...state, version: 2, updatedAt: nowIso() }
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(temp, this.file)
    return next
  }

  async mutate(operation) {
    return this.exclusive(async () => {
      const state = await this.read()
      operation(state)
      return this.write(state)
    })
  }
}

function requireText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw fail('text is required', 'missing-text', 400)
  if (text.length > MAX_TEXT) throw fail(`text exceeds ${MAX_TEXT} characters`, 'text-too-long', 400)
  return text
}

function requireId(value) {
  if (typeof value !== 'string' || !value) throw fail('id is required', 'missing-id', 400)
  return value
}

function requireCategory(value) {
  if (value === undefined || value === null) return 'work'
  if (!CATEGORIES.includes(value)) throw fail(`unknown category: ${String(value)}`, 'bad-category', 400)
  return value
}

function requireMemoSlot(value) {
  if (!MEMO_SLOTS.includes(value)) throw fail(`unknown memo slot: ${String(value)}`, 'bad-memo-slot', 400)
  return value
}

function requireMemoText(value) {
  if (typeof value !== 'string') throw fail('memo text must be a string', 'bad-memo-text', 400)
  if (value.length > MAX_MEMO) throw fail(`memo text exceeds ${MAX_MEMO} characters`, 'memo-too-long', 400)
  return value
}

function findOrFail(list, id, what) {
  const item = list.find((entry) => entry.id === id)
  if (!item) throw fail(`${what} not found: ${id}`, 'not-found', 404)
  return item
}

function applyOperation(state, op, body) {
  const now = nowIso()
  switch (op) {
    case 'todo.add': {
      const text = requireText(body.text)
      const category = requireCategory(body.category)
      state.todos.push({ id: `t_${randomUUID()}`, text, done: false, category, createdAt: now, doneAt: null })
      return
    }
    case 'todo.update': {
      const todo = findOrFail(state.todos, requireId(body.id), 'todo')
      todo.text = requireText(body.text)
      if (body.category !== undefined && body.category !== null) todo.category = requireCategory(body.category)
      return
    }
    case 'todo.toggle': {
      const todo = findOrFail(state.todos, requireId(body.id), 'todo')
      const wasDone = todo.done
      todo.done = typeof body.done === 'boolean' ? body.done : !todo.done
      todo.doneAt = todo.done ? now : null
      // Display order is array order: a freshly completed item goes to the top of
      // the 已完成 list, and an un-completed one stays where it is (top of 未完成).
      if (todo.done && !wasDone) {
        state.todos = state.todos.filter((entry) => entry.id !== todo.id)
        state.todos.unshift(todo)
      }
      return
    }
    case 'todo.move': {
      const todo = findOrFail(state.todos, requireId(body.id), 'todo')
      const beforeId = body.beforeId
      if (beforeId === todo.id) return
      const rest = state.todos.filter((entry) => entry.id !== todo.id)
      if (beforeId === undefined || beforeId === null || beforeId === '') {
        rest.push(todo)
        state.todos = rest
        return
      }
      if (typeof beforeId !== 'string') throw fail('beforeId must be a string or null', 'bad-before-id', 400)
      const index = rest.findIndex((entry) => entry.id === beforeId)
      if (index < 0) throw fail(`todo not found: ${beforeId}`, 'not-found', 404)
      rest.splice(index, 0, todo)
      state.todos = rest
      return
    }
    case 'todo.delete': {
      const id = requireId(body.id)
      findOrFail(state.todos, id, 'todo')
      state.todos = state.todos.filter((todo) => todo.id !== id)
      return
    }
    case 'todo.clearCompleted': {
      const category = body.category === undefined || body.category === null ? null : requireCategory(body.category)
      state.todos = state.todos.filter((todo) => (category ? !(todo.done && todo.category === category) : !todo.done))
      return
    }
    case 'memo.set': {
      const slot = requireMemoSlot(body.slot)
      state.memos[slot] = requireMemoText(body.text)
      return
    }
    default:
      throw fail(`unknown op: ${String(op)}`, 'unknown-op', 400)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { code: 'body-too-large', status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'bad-json', status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const publicState = (state) => ({
  ok: true,
  todos: state.todos,
  memos: state.memos,
  updatedAt: state.updatedAt,
})

export function apply(ctx) {
  const store = new Store(DATA_FILE)

  const route = async (req, res, url) => {
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()

    if (pathname === `${BASE}/api/ping` && method === 'GET') {
      const state = await store.read()
      const open = state.todos.filter((t) => !t.done)
      return sendJson(res, 200, {
        ok: true,
        plugin: name,
        version: VERSION,
        dataFile: DATA_FILE,
        dataExists: existsSync(DATA_FILE),
        counts: {
          todos: state.todos.length,
          openTodos: open.length,
          workOpen: open.filter((t) => t.category === 'work').length,
          personalOpen: open.filter((t) => t.category === 'personal').length,
          memoChars: MEMO_SLOTS.reduce((sum, slot) => sum + state.memos[slot].length, 0),
        },
        updatedAt: state.updatedAt,
        time: nowIso(),
      })
    }

    if (pathname === `${BASE}/api/state` && method === 'GET') {
      return sendJson(res, 200, publicState(await store.read()))
    }

    if (pathname === `${BASE}/api/mutate` && method === 'POST') {
      const body = (await readBody(req)) || {}
      const op = body.op
      const state = await store.mutate((draft) => applyOperation(draft, op, body))
      return sendJson(res, 200, publicState(state))
    }

    if (pathname === `${BASE}/api/client-log` && method === 'POST') {
      const body = (await readBody(req)) || {}
      await mkdir(DATA_DIR, { recursive: true })
      await appendFile(
        path.join(DATA_DIR, 'client.log'),
        JSON.stringify({ at: nowIso(), level: body.level, message: body.message, stack: body.stack, componentStack: body.componentStack }) + '\n',
      )
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: 'unknown notes-todo route', path: pathname, method })
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      await route(req, res, url)
    } catch (error) {
      const status = (error && error.status) || 500
      try {
        sendJson(res, status, {
          ok: false,
          error: String((error && error.message) || error),
          code: (error && error.code) || 'internal',
        })
      } catch {
        /* response already sent / socket closed */
      }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: BASE, handler }))

  if (typeof ctx.logger === 'function') {
    try {
      ctx.logger('[notes-todo]').info?.(`mounted ${BASE} -> ${DATA_FILE}`)
    } catch {
      /* logging is optional */
    }
  }
}
