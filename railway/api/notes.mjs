/* GymNAZA — las notas del usuario en el conector MCP.
 *
 * El MCP oficial de openGym (mcp/src/tools.js) no lee ninguna de las notas que la app guarda,
 * así que un agente nunca las ve. Este módulo las agrega a las respuestas de lectura, sin tocar
 * el código oficial, y suma una herramienta para listarlas.
 *
 * Las cuatro clases de nota que guarda la app (frontend/src/lib/finish-workout.js, history.js):
 *   - nota de la sesión          → workouts[].note
 *   - nota del ejercicio de hoy  → workouts[].entries[].note (+ notePin: "mostrar la próxima vez")
 *   - nota fija del ejercicio    → exNotes[exerciseId] ("siempre en este ejercicio")
 *   - nota del plan (rutina)     → routines[].ex[].note (se copia a entries[].target.note) */
import { z } from 'zod'
import { getState } from './src/state.js'
import { CATALOGUE } from '../frontend/src/lib/exercises.js'
import { pinnedNoteFor, exNoteFor } from '../frontend/src/lib/history.js'

const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const exName = (S, id) => (S.customEx || []).find(e => e.id === id)?.n || CATALOGUE.find(e => e.id === id)?.n || id
const pinnedFor = (S, id) => { const p = pinnedNoteFor(S, id); return p ? { date: p.d, note: p.note } : null }

const LEGEND = {
  session_note: "The user's own note about the whole session (how it went).",
  note: "The user's own note about this exercise in this session. note_pinned = they asked to see it again next time.",
  standing_note: "The user's permanent note for this exercise (seat height, pin, form cue) — shown every session.",
  plan_note: "The routine's note for this exercise (the plan/prescription), not something written during the session.",
}

// Texto que se agrega a la descripción oficial de cada herramienta, para que el agente sepa
// que las notas están ahí.
export const NOTE_DESCRIPTIONS = {
  list_workouts: ' Each workout also carries session_note and exercise_notes: notes the USER wrote during that session — read them, they often explain the numbers (pain, fatigue, machine taken, technique).',
  get_workout: ' Also returns the user\'s own notes: session_note (whole session), and per exercise note / note_pinned (written during this session), standing_note (permanent cue) and plan_note (the routine\'s prescription). Always read and take them into account.',
  get_routine: ' Each exercise also includes plan_note (the routine\'s own note), standing_note (the user\'s permanent cue) and pinned_note_from_last_time (a note the user pinned for next time).',
  preview_session: ' Each exercise also includes plan_note, standing_note and pinned_note_from_last_time — the notes the app shows the user when the session starts.',
}

function routineNotes(S, routineId, exercises) {
  const r = (S.routines || []).find(x => x.id === routineId)
  for (const x of exercises || []) {
    const cfg = r?.ex?.[x.position - 1]
    x.plan_note = cfg && cfg.id === x.id ? clean(cfg.note) : null
    x.standing_note = exNoteFor(S, x.id)
    x.pinned_note_from_last_time = pinnedFor(S, x.id)
  }
}

// Agrega las notas a la respuesta de una herramienta oficial de lectura. Nunca falla: si algo
// no cuadra, devuelve la respuesta tal cual.
export function withNotes(name, result) {
  try {
    if (!result || typeof result !== 'object' || result.error) return result
    const S = getState()
    if (!S) return result
    const workouts = S.workouts || []
    if (name === 'get_workout' && Array.isArray(result.entries)) {
      const w = workouts.find(x => result.id != null ? x.id === result.id : x.d === result.date)
      if (!w) return result
      result.session_note = clean(w.note)
      result.entries.forEach((e, i) => {
        const raw = (w.entries || [])[i]
        if (!raw || raw.id !== e.id) return
        e.note = clean(raw.note)
        e.note_pinned = !!(e.note && raw.notePin)
        e.standing_note = exNoteFor(S, e.id)
        e.plan_note = clean(raw.target?.note)
      })
      result.notes_legend = LEGEND
    } else if (name === 'list_workouts' && Array.isArray(result.workouts)) {
      for (const x of result.workouts) {
        const w = workouts.find(y => y.id === x.id)
        if (!w) continue
        x.session_note = clean(w.note)
        x.exercise_notes = (w.entries || []).filter(e => clean(e.note))
          .map(e => ({ exercise_id: e.id, exercise: exName(S, e.id), note: clean(e.note), pinned: !!e.notePin }))
      }
    } else if ((name === 'get_routine' || name === 'preview_session') && Array.isArray(result.exercises)) {
      routineNotes(S, result.id || result.routine_id, result.exercises)
    }
  } catch { /* las notas son un agregado: si fallan, la respuesta oficial sale igual */ }
  return result
}

export const NOTE_TOOLS = [
  {
    name: 'list_notes',
    description: 'Every note the user has written, newest first: session notes and per-exercise notes left during workouts, plus their permanent per-exercise notes. Filter by date range and/or exercise. Use it to answer "what did I note…" and before advising, since these notes often explain pain, fatigue or technique issues.',
    schema: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      exercise_id: z.string().min(1).optional().describe('Only notes about this exercise (and its permanent note).'),
      limit: z.number().int().min(1).max(200).optional().describe('Max workout notes returned. Default 50.'),
    },
    handler: ({ from, to, exercise_id, limit = 50 }) => {
      const S = getState()
      if (!S) return { error: 'no synced state yet' }
      const out = []
      const ws = (S.workouts || []).filter(w => w && (!from || w.d >= from) && (!to || w.d <= to))
        .sort((a, b) => (b.d || '').localeCompare(a.d || '') || (b.start || 0) - (a.start || 0))
      for (const w of ws) {
        const base = { date: w.d, workout_id: w.id || null, routine_name: w.name || null }
        if (!exercise_id && clean(w.note)) out.push({ ...base, kind: 'session', note: clean(w.note) })
        for (const e of w.entries || []) {
          if (exercise_id && e.id !== exercise_id) continue
          if (clean(e.note)) out.push({ ...base, kind: 'exercise', exercise_id: e.id, exercise: exName(S, e.id), note: clean(e.note), pinned: !!e.notePin })
        }
      }
      const standing = Object.entries(S.exNotes || {})
        .filter(([id, n]) => clean(n) && (!exercise_id || id === exercise_id))
        .map(([id, n]) => ({ exercise_id: id, exercise: exName(S, id), note: clean(n) }))
      return { workout_notes_total: out.length, workout_notes: out.slice(0, limit), standing_notes: standing, legend: LEGEND }
    },
  },
]
