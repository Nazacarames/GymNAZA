/* GymNAZA — herramientas de ESCRITURA para el conector MCP de openGym.
 *
 * Mismo proceso que una carga manual cuidadosa:
 *   1. Leer el perfil por la API oficial (GET /api/data → { state, rev }).
 *   2. Aplicar el cambio sobre una copia y describirlo.
 *   3. Sin `confirm: true` → solo vista previa, no se escribe nada.
 *   4. Con `confirm: true` → PUT /api/data con baseRev (si otro dispositivo guardó en el medio, la
 *      API responde 409 y no se pisa nada), y backup del estado anterior en /data/mcp-backups.
 *
 * La escritura pasa por la API (no por el archivo) para usar su control de versiones. Para
 * autenticarse, este proceso (que corre dentro del mismo contenedor que la API) firma una sesión
 * de 5 minutos para el perfil servido con la clave del propio servidor, igual que haría un login. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import { CATALOGUE, searchScore } from '../frontend/src/lib/exercises.js'
import { getUser } from './src/state.js'

const DATA = process.env.OPENGYM_DATA || '/data'
const API = `http://127.0.0.1:${process.env.PORT || 8080}`
const BACKUP_DIR = path.join(DATA, 'mcp-backups')
const KEEP_BACKUPS = 30
// Copiado de frontend/src/lib/glyphs.js (ese módulo importa un componente JSX y no carga en Node).
const ICONS = ['figureStrength', 'arm', 'abs', 'legs', 'pullup', 'dumbbell', 'barbell', 'kettlebell', 'plate', 'machine',
  'figureRun', 'bike', 'swim', 'boxing', 'timer', 'stretch', 'moon', 'heart', 'flame', 'bolt']
const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const DAYN = Object.keys(DAYS)

class ToolError extends Error { constructor(code, msg) { super(msg); this.code = code } }
const clone = o => JSON.parse(JSON.stringify(o))
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)   // igual que lib/format.js
const isoToday = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

// ---------- API ----------
function sessionToken() {
  const secret = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim()
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'))
  const id = getUser().id
  const user = db.users.find(u => u.id === id)
  if (!user) throw new ToolError('NO_PROFILE', 'The served profile no longer exists.')
  if (user.disabled) throw new ToolError('DISABLED', 'The served profile is disabled.')
  const payload = `${id}:${Date.now() + 5 * 60000}:${user.sv || 0}`
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}
async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionToken() },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await r.json() } catch { /* no json */ }
  return { status: r.status, data }
}

// ---------- backups ----------
function saveBackup(tool, before, revBefore, revAfter) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-rev${revBefore}.json`)
  fs.writeFileSync(file, JSON.stringify({ tool, at: new Date().toISOString(), rev_before: revBefore, rev_after: revAfter, state: before }), { mode: 0o600 })
  const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort()
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f))
  return path.basename(file)
}
function lastBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null
  const f = fs.readdirSync(BACKUP_DIR).filter(x => x.endsWith('.json')).sort().pop()
  return f ? { file: f, ...JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8')) } : null
}

// Lee, aplica `change` sobre una copia (devuelve la lista de cambios en texto) y, con confirm,
// escribe con baseRev. Nada se escribe si `change` lanza un error de validación.
async function mutate(tool, confirm, change) {
  const got = await api('GET', '/api/data')
  if (got.status !== 200) throw new ToolError('READ_FAILED', `Could not read the profile (HTTP ${got.status}).`)
  const before = got.data.state || {}
  const rev = got.data.rev || 0
  const next = clone(before)
  const changes = change(next)
  if (!changes.length) return { mode: 'no-op', message: 'Nothing to change — the profile already matches.' }
  if (!confirm) {
    return { mode: 'preview', written: false, profile_rev: rev, changes,
      next_step: 'Nothing was written. Show these changes to the user and, only if they agree, call this tool again with the same arguments plus confirm: true.' }
  }
  next._ts = Date.now()
  delete next._rev
  const put = await api('PUT', '/api/data', { state: next, baseRev: rev })
  if (put.status === 409) throw new ToolError('CONFLICT', 'The profile changed on another device while this was being applied. Nothing was written — call the tool again to re-read and retry.')
  if (put.status !== 200) throw new ToolError('WRITE_FAILED', `The server refused the write (HTTP ${put.status}${put.data?.error ? ': ' + put.data.error : ''}). Nothing was written.`)
  const backup = saveBackup(tool, before, rev, put.data.rev)
  return { mode: 'applied', written: true, rev_before: rev, rev_after: put.data.rev, changes, backup,
    note: 'Saved. Open devices pick it up within ~30 s or when the app is reopened. undo_last_change can revert it.' }
}

// ---------- helpers de dominio ----------
const exName = (state, id) => (state.customEx || []).find(e => e.id === id)?.n || CATALOGUE.find(e => e.id === id)?.n || null
const routineById = (state, id) => {
  const r = (state.routines || []).find(x => x && x.id === id)
  if (!r) throw new ToolError('NO_ROUTINE', `No routine with id "${id}". Use list_routines to get ids.`)
  return r
}
const checkIcon = icon => {
  if (icon != null && !ICONS.includes(icon)) throw new ToolError('BAD_ICON', `Unknown icon "${icon}". Valid: ${ICONS.join(', ')}`)
}
const describeEx = (state, e) => `${e.id} ${exName(state, e.id)} ${e.sets}×${e.repsMin ? e.repsMin + '-' : ''}${e.reps}${e.weight ? ' @' + e.weight : ''}`
function buildExercises(state, list) {
  return list.map((x, i) => {
    if (!exName(state, x.id)) throw new ToolError('NO_EXERCISE', `Exercise #${i + 1}: id "${x.id}" is not in the library. Use search_exercises to find a real id.`)
    const reps = x.reps
    if (x.reps_min != null && x.reps_min > reps) throw new ToolError('BAD_RANGE', `Exercise #${i + 1}: reps_min (${x.reps_min}) is above reps (${reps}).`)
    // Igual que el editor de la app: un rango se guarda como reps (tope) + repsMin (piso) con
    // progresión "double"; sin rango, reps fijas y la progresión de la rutina.
    const e = { id: x.id, sets: x.sets, mode: 'reps', reps, weight: x.weight || 0 }
    if (x.reps_min != null && x.reps_min < reps) { e.repsMin = x.reps_min; e.prog = 'double' }
    if (x.rest_sec) e.restSec = x.rest_sec
    if (x.note) e.note = x.note
    return e
  })
}

// ---------- esquemas ----------
const exerciseSpec = z.object({
  id: z.string().min(1).describe('Exercise id from search_exercises (e.g. "0025").'),
  sets: z.number().int().min(1).max(20),
  reps: z.number().int().min(1).max(100).describe('Target reps, or the TOP of the range when reps_min is given.'),
  reps_min: z.number().int().min(1).max(100).optional().describe('Bottom of a rep range (e.g. 8 for 8-10). Enables double progression.'),
  weight: z.number().min(0).max(1000).optional().describe('Starting weight in the profile unit. Omit or 0 = the first session sets the baseline.'),
  rest_sec: z.number().int().min(0).max(1800).optional(),
  note: z.string().max(200).optional(),
}).strict()
const confirm = z.boolean().optional().describe('false/omitted = preview only (nothing written). true = write. Always preview and get the user\'s OK first.')
const dayKey = z.enum(DAYN)

// ---------- herramientas ----------
export const WRITE_TOOLS = [
  {
    name: 'search_exercises',
    description: 'Search the openGym exercise library (English names) and the user\'s custom exercises. Returns real exercise ids to use in create_routine / update_routine. Translate Spanish names to English before searching (e.g. "press inclinado con mancuernas" → "dumbbell incline press"). When several results fit, ask the user which one instead of guessing.',
    schema: { query: z.string().min(1).max(80), limit: z.number().int().min(1).max(30).optional() },
    handler: async ({ query, limit = 10 }) => {
      const got = await api('GET', '/api/data')
      const custom = (got.data?.state?.customEx || []).map(e => ({ ...e, custom: true }))
      return [...custom, ...CATALOGUE]
        .map(e => ({ e, s: searchScore(e, query) })).filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s).slice(0, limit)
        .map(({ e }) => ({ id: e.id, name: e.n, body_part: e.bp, equipment: e.eq, target: e.tg, ...(e.custom ? { custom: true } : {}) }))
    },
  },
  {
    name: 'create_routine',
    description: 'Create a new routine (preview first; writes only with confirm: true). Optionally assign it to a weekday. Refuses a name that already exists.',
    schema: {
      name: z.string().min(1).max(60),
      icon: z.string().optional().describe('Icon key: ' + ICONS.join(', ') + '. Default figureStrength.'),
      exercises: z.array(exerciseSpec).min(1).max(40),
      weekday: dayKey.optional().describe('Also put it on this weekday in the weekly plan (replaces what is there).'),
      confirm,
    },
    handler: async ({ name, icon, exercises, weekday, confirm: ok }) => {
      checkIcon(icon)
      return mutate('create_routine', ok, s => {
        s.routines = Array.isArray(s.routines) ? s.routines : []
        if (s.routines.some(r => (r.name || '').trim().toLowerCase() === name.trim().toLowerCase())) throw new ToolError('DUPLICATE', `A routine called "${name}" already exists. Use update_routine or pick another name.`)
        const r = { id: uid(), name: name.trim(), emoji: icon || 'figureStrength', ex: buildExercises(s, exercises) }
        s.routines.push(r)
        const out = [`+ routine "${r.name}" (${r.ex.length} exercises): ${r.ex.map(e => describeEx(s, e)).join('; ')}`]
        if (weekday) {
          s.week = s.week || {}
          const prev = s.week[DAYS[weekday]]
          s.week[DAYS[weekday]] = r.id
          out.push(`~ ${weekday}: ${prev ? `"${routineById(s, prev).name}"` : 'rest'} → "${r.name}"`)
        }
        return out
      })
    },
  },
  {
    name: 'update_routine',
    description: 'Change an existing routine: rename it, change its icon, and/or REPLACE its whole exercise list (send the full new list). Preview first; writes only with confirm: true.',
    schema: {
      routine_id: z.string().min(1),
      name: z.string().min(1).max(60).optional(),
      icon: z.string().optional(),
      exercises: z.array(exerciseSpec).min(1).max(40).optional(),
      confirm,
    },
    handler: async ({ routine_id, name, icon, exercises, confirm: ok }) => {
      checkIcon(icon)
      return mutate('update_routine', ok, s => {
        const r = routineById(s, routine_id)
        const out = []
        if (name && name.trim() !== r.name) {
          if (s.routines.some(x => x !== r && (x.name || '').trim().toLowerCase() === name.trim().toLowerCase())) throw new ToolError('DUPLICATE', `Another routine is already called "${name}".`)
          out.push(`~ name: "${r.name}" → "${name.trim()}"`); r.name = name.trim()
        }
        if (icon && icon !== r.emoji) { out.push(`~ icon: ${r.emoji} → ${icon}`); r.emoji = icon }
        if (exercises) {
          const nx = buildExercises(s, exercises)
          if (JSON.stringify(nx) !== JSON.stringify(r.ex)) {
            out.push(`~ exercises of "${r.name}":\n    before: ${(r.ex || []).map(e => describeEx(s, e)).join('; ') || '(none)'}\n    after:  ${nx.map(e => describeEx(s, e)).join('; ')}`)
            r.ex = nx
          }
        }
        return out
      })
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete a routine and remove it from the weekly plan and any date overrides. Logged workouts are kept. Preview first; writes only with confirm: true.',
    schema: { routine_id: z.string().min(1), confirm },
    handler: async ({ routine_id, confirm: ok }) => mutate('delete_routine', ok, s => {
      const r = routineById(s, routine_id)
      s.routines = s.routines.filter(x => x !== r)
      const out = [`- routine "${r.name}" (${(r.ex || []).length} exercises)`]
      for (const [d, id] of Object.entries(s.week || {})) if (id === r.id) { delete s.week[d]; out.push(`~ ${DAYN[d]}: "${r.name}" → rest`) }
      for (const [d, id] of Object.entries(s.dayPlan || {})) if (id === r.id) { delete s.dayPlan[d]; out.push(`- date override ${d}`) }
      return out
    }),
  },
  {
    name: 'set_week_plan',
    description: 'Assign routines to weekdays. Only the days you send change; use "rest" to clear a day. Example: { "days": { "monday": "<routine_id>", "tuesday": "rest" } }. Preview first; writes only with confirm: true.',
    schema: { days: z.object(Object.fromEntries(DAYN.map(d => [d, z.string().min(1).optional()]))).strict().describe('weekday → routine_id or "rest"; omitted days stay as they are'), confirm },
    handler: async ({ days, confirm: ok }) => mutate('set_week_plan', ok, s => {
      s.week = s.week || {}
      const out = []
      for (const [day, val] of Object.entries(days).filter(([, v]) => v != null)) {
        const k = DAYS[day]
        const prev = s.week[k]
        const next = val === 'rest' ? undefined : routineById(s, val).id
        if (prev === next) continue
        const label = id => (id ? `"${routineById(s, id).name}"` : 'rest')
        out.push(`~ ${day}: ${label(prev)} → ${label(next)}`)
        if (next) s.week[k] = next; else delete s.week[k]
      }
      return out
    }),
  },
  {
    name: 'log_bodyweight',
    description: 'Log a body-weight entry (one per day; an existing entry for that date is replaced). Preview first; writes only with confirm: true.',
    schema: {
      weight: z.number().min(20).max(400).describe('In the profile unit (usually kg).'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD in the USER'S local date. Always pass it: the server runs on UTC, so its 'today' can differ."),
      confirm,
    },
    handler: async ({ weight, date, confirm: ok }) => mutate('log_bodyweight', ok, s => {
      const d = date || isoToday()
      s.bodyweight = (Array.isArray(s.bodyweight) ? s.bodyweight : []).filter(b => b && b.d)
      const prev = s.bodyweight.find(b => b.d === d)
      if (prev && prev.w === weight) return []
      s.bodyweight = s.bodyweight.filter(b => b.d !== d)
      s.bodyweight.push({ d, w: Math.round(weight * 10) / 10, t: Date.now() })
      s.bodyweight.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
      return [prev ? `~ weigh-in ${d}: ${prev.w} → ${weight}` : `+ weigh-in ${d}: ${weight}`]
    }),
  },
  {
    name: 'set_target_weight',
    description: 'Set or clear (null) the body-weight goal. Never invent a goal — only set one the user stated. Preview first; writes only with confirm: true.',
    schema: { weight: z.number().min(20).max(400).nullable(), confirm },
    handler: async ({ weight, confirm: ok }) => mutate('set_target_weight', ok, s => {
      if ((s.targetW ?? null) === weight) return []
      const out = [`~ goal: ${s.targetW ?? 'none'} → ${weight ?? 'none'}`]
      s.targetW = weight
      return out
    }),
  },
  {
    name: 'undo_last_change',
    description: 'Revert the most recent change made through this connector, restoring the profile exactly as it was before it. Refused if anything else changed the profile since (e.g. a workout logged on the phone). Preview first; writes only with confirm: true.',
    schema: { confirm },
    handler: async ({ confirm: ok }) => {
      const b = lastBackup()
      if (!b) throw new ToolError('NO_BACKUP', 'There is no connector change to undo.')
      const got = await api('GET', '/api/data')
      const rev = got.data?.rev || 0
      if (rev !== b.rev_after) throw new ToolError('CHANGED_SINCE', `The profile changed after that edit (rev ${b.rev_after} → ${rev}), so undoing it would also erase the newer changes. Nothing was written.`)
      const summary = [`↩ revert "${b.tool}" from ${b.at} (rev ${b.rev_after} → restore state of rev ${b.rev_before})`]
      if (!ok) return { mode: 'preview', written: false, changes: summary, next_step: 'Nothing was written. Call again with confirm: true to revert.' }
      const restored = clone(b.state); delete restored._rev; restored._ts = Date.now()
      const put = await api('PUT', '/api/data', { state: restored, baseRev: rev })
      if (put.status !== 200) throw new ToolError(put.status === 409 ? 'CONFLICT' : 'WRITE_FAILED', `Undo refused (HTTP ${put.status}). Nothing was written.`)
      fs.renameSync(path.join(BACKUP_DIR, b.file), path.join(BACKUP_DIR, b.file.replace(/\.json$/, '.undone')))
      return { mode: 'applied', written: true, rev_after: put.data.rev, changes: summary }
    },
  },
]
