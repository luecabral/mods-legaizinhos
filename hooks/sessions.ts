import type { EngineInterface, McpToolResult } from 'claude-code'

import type { Figures, Kid } from '../types'

// Sessões aninhadas do app: cada sessão (o mod carrega em todas) publica seus
// números no $.store, que é um só para todas as sessões da máquina. A sessão
// mãe pergunta ao app quais sessões ela começou (list_sessions linked) e lê os
// números de cada uma no store.

const SERVER = 'ccd_session_mgmt'
const KEY = (id: string) => `sessao:${id}`
/** As filhas que esta sessão já viu (id → título): a mescla conta mesmo depois que o app apaga a filha. */
const KIDS_KEY = (me: string) => `filhas:${me}`
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const KIDS_TTL_MS = 5000
const HEAD_TTL_MS = 15_000

/** O id `local_…` com que o app conhece esta sessão. */
export function hostId($: EngineInterface) {
  return $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
}

const textOf = (r: McpToolResult) => {
  for (const c of r.content) if (c.type === 'text' && 'text' in c && typeof c.text === 'string') return c.text
  return undefined
}

/** O JSON que a ferramenta do app devolve como texto; undefined quando é uma frase ("No other sessions found."). */
export const parseJson = (text: string | undefined): unknown => {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type Row = { sessionId?: string; title?: string; startedBy?: string; isRunning?: boolean; isArchived?: boolean; model?: string }

export const rowsOf = (v: unknown): Row[] =>
  Array.isArray(v) ? (v as Row[]) : Array.isArray((v as { sessions?: unknown })?.sessions) ? (v as { sessions: Row[] }).sessions : []

/**
 * A aninhada foi mesclada aqui quando fez commits (o HEAD dela saiu de onde
 * começou) e o HEAD dela já está no histórico desta sessão.
 */
export const isMerged = (f: Figures | undefined, ancestor: boolean) =>
  !!f?.head && !!f.startHead && f.head !== f.startHead && ancestor

/** Aparece como aninhada: nem mesclada, nem desaninhada, nem arquivada. */
export const isNested = (k: Kid) => !k.merged && !k.detached && !k.archived

let head = { at: -Infinity, sha: undefined as string | undefined }
async function gitHead($: EngineInterface, now: number) {
  if (now - head.at < HEAD_TTL_MS) return head.sha
  head = { at: now, sha: undefined }
  try {
    const r = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 3000 })
    if (r.exitCode === 0) head.sha = r.stdout.trim() || undefined
  } catch {}
  return head.sha
}

const ancestors = new Map<string, boolean>()
async function isAncestor($: EngineInterface, sha: string, of: string) {
  const key = `${sha}..${of}`
  const known = ancestors.get(key)
  if (known !== undefined) return known
  let yes = false
  try {
    yes = (await $.process.run(['git', 'merge-base', '--is-ancestor', sha, of], { timeoutMs: 3000 })).exitCode === 0
  } catch {}
  // Só guarda o "sim": um "não" pode virar "sim" depois da mescla.
  if (yes) ancestors.set(key, true)
  return yes
}

let lastPublish = -Infinity
let startHead: string | undefined

/** Publica os números desta sessão para a sessão mãe ler; no máximo a cada 3 s, salvo `force`. */
export async function publishSelf($: EngineInterface, f: Omit<Figures, 'head' | 'startHead' | 'updatedAt'>, force = false) {
  const now = await $.clock.now()
  if (!force && now - lastPublish < 3000) return
  lastPublish = now
  const id = await hostId($)
  if (!id) return
  const sha = await gitHead($, now)
  if (startHead === undefined) {
    const prev = (await $.store.get(KEY(id))) as Figures | undefined
    startHead = prev?.startHead ?? sha
  }
  await $.store.set(KEY(id), { ...f, head: sha, startHead, updatedAt: now } satisfies Figures)
}

/** Apaga do store o que sessões paradas há mais de 7 dias publicaram. */
export async function pruneStore($: EngineInterface) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('sessao:')) continue
    const f = (await $.store.get(key)) as Figures | undefined
    if (!f || now - (f.updatedAt ?? 0) > KEEP_MS) await $.store.delete(key)
  }
}

let kids = { at: -Infinity, list: [] as Kid[] }

/** As sessões que esta começou, com os números de cada uma; lido do app no máximo a cada 5 s. */
export async function sessionKids($: EngineInterface, now: number) {
  if (now - kids.at < KIDS_TTL_MS) return kids.list
  kids = { ...kids, at: now }
  try {
    const me = await hostId($)
    if (!me) return kids.list
    const rows = rowsOf(parseJson(textOf(await $.mcp.call(SERVER, 'list_sessions', { linked: true, include_archived: true }))))
    const mine = rows.filter(r => r.startedBy === me && r.sessionId)
    const myHead = await gitHead($, now)
    const known = ((await $.store.get(KIDS_KEY(me))) as Record<string, string> | undefined) ?? {}
    const seen = { ...known }
    for (const r of mine) seen[r.sessionId as string] = r.title || known[r.sessionId as string] || (r.sessionId as string)
    if (JSON.stringify(seen) !== JSON.stringify(known)) await $.store.set(KIDS_KEY(me), seen)
    // Filhas que o app não lista mais (apagadas): só contam se foram mescladas.
    const gone = await Promise.all(
      Object.keys(seen)
        .filter(id => !mine.some(r => r.sessionId === id))
        .map(async (id): Promise<Kid> => {
          const figures = (await $.store.get(KEY(id))) as Figures | undefined
          const ancestor = !!figures?.head && !!myHead && (await isAncestor($, figures.head, myHead))
          return { id, title: seen[id] ?? id, running: false, archived: true, detached: false, figures, merged: isMerged(figures, ancestor) }
        }),
    )
    const list = await Promise.all(
      mine.map(async (r): Promise<Kid> => {
        const id = r.sessionId as string
        let s: { detached?: boolean; model?: string; effort?: string; title?: string } = {}
        try {
          s = (parseJson(textOf(await $.mcp.call(SERVER, 'get_session', { session_id: id }))) as typeof s) ?? {}
        } catch {}
        const figures = (await $.store.get(KEY(id))) as Figures | undefined
        const ancestor = !!figures?.head && !!myHead && (await isAncestor($, figures.head, myHead))
        return {
          id,
          title: r.title || s.title || id,
          running: !!r.isRunning,
          archived: !!r.isArchived,
          detached: !!s.detached,
          model: s.model ?? r.model,
          effort: s.effort,
          figures,
          merged: isMerged(figures, ancestor),
        }
      }),
    )
    kids = { at: now, list: [...list, ...gone] }
  } catch {}
  return kids.list
}

/** Há aninhada rodando agora: mantém o painel se atualizando. */
export const kidsLive = () => kids.list.some(k => isNested(k) && k.running)
