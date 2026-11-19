import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, Bg, BranchInfo, Kid, Launch, Merged, Pr, Run, Tokens } from '../types'
import { priceOf } from './prices'
import { scanGeminiCli } from './gemini-cli'
import { isNested, kidsLive, publishSelf, pruneStore, sessionKids } from './sessions'

const PANE = 'subagentes'
const MAIN = 'main'
const STALE_MS = 5 * 60 * 1000
const TICK_MS = 2000
const DONE_SHOWN = 6
// Troque a tag quando o formato de Run mudar: ela descarta o que uma versão
// anterior guardou e que sobrevive ao reload.
const runs = atom({ plugin: 'subagentes', key: 'runs' } as const, {}, { shape: 'runs-2' })
const merged = atom({ plugin: 'subagentes', key: 'merged' } as const, {} as Record<string, Merged>, { shape: 'merged-1' })
/** Os comandos de Gemini desta sessão: o painel mostra só o Gemini que ela mesma começou. */
const launches = atom({ plugin: 'subagentes', key: 'launches' } as const, [] as Launch[], { shape: 'launches-1' })
/** O que a principal está fazendo agora e as tarefas em segundo plano desta sessão. */
const activity = atom({ plugin: 'subagentes', key: 'activity' } as const, { bg: {} } as Activity, { shape: 'activity-1' })
const BG_KEEP_MS = 12 * 60 * 60 * 1000
/** Todos os PRs que esta sessão abriu ou em que trabalhou, pela URL. */
const prsState = atom({ plugin: 'subagentes', key: 'prs' } as const, {} as Record<string, Pr>, { shape: 'prs-2' })
const awayState = atom({ plugin: 'subagentes', key: 'away' } as const, false, { shape: 'away-1' })

/** O pedido que o botão manda pra sessão: só o Claude dela alcança essas duas ferramentas do app. */
export const awayPrompt = (on: boolean) =>
  on
    ? 'liga o controle remoto desta sessão (mcp__ccd_session_mgmt__set_remote_control com session_id "self" e enabled true) e mantém o computador acordado enquanto ela trabalha (mcp__ccd_host__request_keep_awake com until "session_idle"). só isso, sem mexer em mais nada'
    : 'desliga o controle remoto desta sessão (mcp__ccd_session_mgmt__set_remote_control com session_id "self" e enabled false). só isso, sem mexer em mais nada'

const menuState = atom({ plugin: 'subagentes', key: 'menu' } as const, null as string | null, { shape: 'menu-1' })
const branchState = atom({ plugin: 'subagentes', key: 'branch' } as const, null as BranchInfo | null, { shape: 'branch-2' })
const PR_EVERY_MS = 30_000
const PR_FIELDS = 'number,title,url,additions,deletions,isDraft,state,statusCheckRollup,headRefName'
let prAt = 0

/** URLs de PR do GitHub num texto (saída do gh pr create, por exemplo). */
export const prUrls = (text: string) => [...new Set(text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g) ?? [])]

const FAIL = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const PASS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

/** Um PR do JSON do gh (`pr view` ou um item de `pr list`). */
export const prFrom = (j: Record<string, any>): Pr | null => {
  if (!j || typeof j.number !== 'number') return null
  let failing = 0
  let pending = 0
  let passed = 0
  const checks = (j.statusCheckRollup ?? []) as Record<string, string>[]
  for (const c of checks) {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase()
    if (FAIL.includes(v)) failing++
    else if (PASS.includes(v)) passed++
    else pending++
  }
  const url = String(j.url ?? '')
  return {
    number: j.number,
    title: String(j.title ?? ''),
    url,
    added: j.additions ?? 0,
    removed: j.deletions ?? 0,
    draft: !!j.isDraft,
    state: String(j.state ?? 'OPEN'),
    failing,
    pending,
    passed,
    total: checks.length,
    branch: typeof j.headRefName === 'string' ? j.headRefName : undefined,
    repo: url.match(/github\.com\/[^/]+\/([^/]+)\/pull\//)?.[1] ?? '',
  }
}

/** Lê o JSON de `gh pr view --json …`. */
export const parsePr = (text: string): Pr | null => {
  try {
    return prFrom(JSON.parse(text))
  } catch {
    return null
  }
}

/** Branches por onde esta sessão passou, pelo reflog (`%gd\t%gs` com --date=unix), desde `since` (ms). */
export const reflogBranches = (text: string, since: number) => {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const m = line.match(/^HEAD@\{(\d+)\}\tcheckout: moving from (\S+) to (\S+)/)
    if (!m || Number(m[1]) * 1000 < since - 60_000) continue
    for (const b of [m[2] ?? '', m[3] ?? '']) if (b && !/^[0-9a-f]{7,40}$/.test(b) && !b.startsWith('origin/') && b !== 'HEAD') out.add(b)
  }
  return [...out]
}

/** Status à direita, como o app: "1 falhando", "● 3/6" enquanto roda, "● 6/6" quando passou. */
export const prStatus = (p: Pr): { text: string; color: string; dot?: string } | undefined => {
  if (p.state === 'MERGED') return undefined
  if (p.state === 'CLOSED') return { text: 'fechado', color: 'subtle' }
  if (p.failing) return { text: `${p.failing} falhando`, color: 'error' }
  if (!p.total) return undefined
  return { text: `${p.passed}/${p.total}`, color: 'subtle', dot: p.pending ? 'subtle' : 'success' }
}

const gh = async ($: EngineInterface, argv: string[]) => {
  const r = await $.process.run(['gh', ...argv], { timeoutMs: 20_000 })
  return r.exitCode === 0 ? r.stdout : undefined
}
const git = async ($: EngineInterface, argv: string[]) => {
  try {
    const r = await $.process.run(['git', ...argv], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** O PR passou de aberto para mergeado ou fechado: avisa. */
export const prTransitions = (before: Record<string, Pr>, after: Record<string, Pr>) =>
  Object.values(after).filter(p => before[p.url]?.state === 'OPEN' && p.state !== 'OPEN')

/** Soma linhas de `git diff --numstat` (binários, com "-", não contam). */
export const parseNumstat = (text: string) => {
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+)\t(\d+)\t/)
    if (m) {
      added += Number(m[1])
      removed += Number(m[2])
    }
  }
  return { added, removed }
}

/** Soma as linhas de `wc -l arq…`, sem a linha "total". */
export const parseWc = (text: string) =>
  text
    .split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m && m[2] !== 'total')
    .reduce((s, m) => s + Number(m[1]), 0)

let branchAt = 0
let knownPrBranches: string[] = []

/**
 * A branch atual como o app mostra em Alterações: repo, +/− contra a base
 * (commits à frente, arquivos alterados e novos) e se dá para criar PR.
 */
const refreshBranch = async ($: EngineInterface, force = false) => {
  const now = await $.clock.now()
  if (!force && now - branchAt < 5000) return
  branchAt = now
  let info: BranchInfo | null = null
  const name = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (name && name !== 'HEAD') {
    const base = (await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'origin/main'
    const onBase = name === base.replace(/^origin\//, '')
    const from = (await git($, ['merge-base', 'HEAD', base])) ?? base
    const diff = parseNumstat((await git($, ['diff', '--numstat', from])) ?? '')
    const untracked = ((await git($, ['ls-files', '--others', '--exclude-standard'])) ?? '').split('\n').filter(Boolean).slice(0, 300)
    if (untracked.length)
      try {
        const r = await $.process.run(['wc', '-l', ...untracked], { timeoutMs: 10_000 })
        diff.added += parseWc(r.stdout)
      } catch {}
    const repo = ((await git($, ['remote', 'get-url', 'origin'])) ?? '').replace(/\.git$/, '').split(/[/:]/).pop() ?? ''
    const hasPr = knownPrBranches.includes(name)
    const ahead = Number((await git($, ['rev-list', '--count', `${base}..HEAD`])) ?? 0)
    info = { name, repo, hasPr, ...diff, canCreate: !onBase && !hasPr && (ahead > 0 || diff.added + diff.removed > 0 || untracked.length > 0) }
  }
  if (JSON.stringify(info) !== JSON.stringify(await read($, branchState))) await update($, branchState, () => info)
}

/**
 * Atualiza os PRs da sessão: o da branch atual, os já vistos que seguem abertos
 * e os de `extra` (URLs recém-criadas). No máximo a cada 30 s, ou já com force.
 */
const refreshPr = async ($: EngineInterface, force = false, extra: string[] = []) => {
  const now = await $.clock.now()
  if (!force && !extra.length && now - prAt < PR_EVERY_MS) return
  prAt = now
  const before = await read($, prsState)
  const fresh: Record<string, Pr> = {}
  let current: Pr | null = null
  try {
    const out = await gh($, ['pr', 'view', '--json', PR_FIELDS])
    current = out ? parsePr(out) : null
  } catch {}
  if (current) fresh[current.url] = current
  // PRs das branches por onde a sessão passou (o app lista os de todas).
  try {
    const since = (await $.session.usage()).startedAt
    const log = await git($, ['reflog', '--date=unix', '--format=%gd%x09%gs', '-n', '300'])
    const here = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branches = new Set([...(log ? reflogBranches(log, since) : []), ...(here && here !== 'HEAD' ? [here] : [])])
    const base = ((await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'origin/main').replace(/^origin\//, '')
    branches.delete(base)
    for (const b of branches) {
      const out = await gh($, ['pr', 'list', '--head', b, '--state', 'all', '--limit', '3', '--json', PR_FIELDS])
      for (const j of out ? (JSON.parse(out) as Record<string, any>[]) : []) {
        const p = prFrom(j)
        if (p) fresh[p.url] = p
      }
    }
  } catch {}
  const open = Object.values(before).filter(p => p.state === 'OPEN').map(p => p.url)
  for (const url of new Set([...open, ...extra]))
    if (!fresh[url])
      try {
        const out = await gh($, ['pr', 'view', url, '--json', PR_FIELDS])
        const p = out ? parsePr(out) : null
        if (p) fresh[p.url] = p
      } catch {}
  const known = [...Object.values(before), ...Object.values(fresh)]
  knownPrBranches = [...new Set([...(current?.branch ? [current.branch] : []), ...known.filter(p => p.state !== 'CLOSED' && p.branch).map(p => p.branch as string)])]
  await refreshBranch($, true)
  if (!Object.keys(fresh).length) return
  const merged = { ...before }
  for (const p of Object.values(fresh)) merged[p.url] = { ...p, seenAt: before[p.url]?.seenAt ?? now }
  if (JSON.stringify(merged) === JSON.stringify(before)) return
  await update($, prsState, all => {
    const out = { ...all }
    for (const p of Object.values(fresh)) out[p.url] = { ...p, seenAt: all[p.url]?.seenAt ?? now }
    return out
  })
  if (Object.values(merged).some(p => p.state === 'OPEN')) startTicker($)
  for (const p of prTransitions(before, merged)) {
    const text = p.state === 'MERGED' ? `PR #${p.number} mergeado: ${p.title}` : `PR #${p.number} fechado sem merge: ${p.title}`
    $.ui.toast(text, { timeoutMs: 8000 })
    void $.ui.notify(text, { title: p.state === 'MERGED' ? 'PR mergeado' : 'PR fechado' }).catch(() => {})
  }
}

/** Roda uma ação do gh num PR e avisa como foi. */
const prAction = async ($: EngineInterface, p: Pr, argv: string[], doing: string, done: string) => {
  $.ui.toast(`${doing} #${p.number}…`)
  try {
    const r = await $.process.run(['gh', ...argv], { timeoutMs: 30_000 })
    if (r.exitCode === 0) $.ui.toast(`#${p.number} ${done}`)
    else $.ui.toast(`Não deu certo: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? 'erro do gh'}`, { timeoutMs: 8000 })
  } catch (err) {
    $.ui.toast(`Não deu certo: ${String(err)}`, { timeoutMs: 8000 })
  }
  await refreshPr($, true, [p.url])
}

/** Nome curto de um comando: a primeira linha, sem espaços repetidos. */
const cmdLabel = (command: string, n = 60) => {
  const line = command.split('\n').find(l => l.trim()) ?? command
  const s = line.trim().replace(/\s+/g, ' ')
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** O que a principal está fazendo, em português, a partir da ferramenta que chamou. */
export const toolLabel = (tool: string, input: Record<string, unknown>) => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const file = (s('file_path') || s('path') || s('notebook_path')).split('/').pop() ?? ''
  switch (tool) {
    case 'Bash':
      return `Executando ${cmdLabel(s('command'), 48)}`
    case 'Read':
      return `Lendo ${file}`
    case 'Edit':
    case 'NotebookEdit':
      return `Editando ${file}`
    case 'Write':
      return `Criando ${file}`
    case 'Grep':
    case 'Glob':
      return `Buscando ${cmdLabel(s('pattern'), 36)}`
    case 'Agent':
      return `Disparando subagente${s('description') ? `: ${s('description')}` : ''}`
    case 'WebFetch':
    case 'WebSearch':
      return 'Pesquisando na web'
    case 'AskUserQuestion':
      return 'Esperando sua resposta'
    default:
      return `Usando ${tool.includes('__') ? tool.split('__').pop() : tool}`
  }
}

/** Status e id de uma notificação de tarefa em segundo plano (<task-id>…</task-id><status>…</status>). */
export const taskNotice = (text: string) => {
  const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
  const status = text.match(/<status>([^<]+)<\/status>/)?.[1]?.trim()
  return id ? { id, status: status ?? 'completed' } : undefined
}

/** Fecha as tarefas que acabaram e esquece as que acabaram há mais de 12 h. */
export const endBg = (bg: Record<string, Bg>, id: string, now: number, status: string) =>
  bg[id] && bg[id].endedAt === undefined ? { ...bg, [id]: { ...bg[id], endedAt: now, status } } : bg

/** Sem sinal de vida há tanto tempo, uma tarefa que não é de shell é dada como acabada. */
export const BG_SILENT_MS = 2 * 60 * 60 * 1000

/** O comando de uma tarefa de shell ainda aparece na lista de processos (`ps -axo args=`)? */
export const shellAlive = (command: string, psOut: string) => {
  const key = command.split('\n').find(l => l.trim())?.trim().slice(0, 120)
  if (!key) return true
  return psOut.split('\n').some(l => l.includes(key))
}

/**
 * Fecha o que já acabou sem que o motor avisasse (parada sem notificação, aviso perdido na compactação).
 * Shell: some quando o processo não existe mais. Outras: some se ninguém confirmou há 2 h.
 * `psOut` é undefined quando o ps falhou: aí só vale o tempo.
 */
export const reapBg = (bg: Record<string, Bg>, now: number, psOut: string | undefined) => {
  let out = bg
  for (const b of Object.values(bg)) {
    if (b.endedAt !== undefined) continue
    const young = now - (b.seenAt ?? b.at) < 30_000
    const dead = b.command
      ? psOut !== undefined && !young && !shellAlive(b.command, psOut)
      : now - (b.seenAt ?? b.at) > BG_SILENT_MS
    if (dead) out = endBg(out, b.id, now, 'completed')
  }
  return out
}

export const pruneBg = (bg: Record<string, Bg>, now: number) =>
  Object.fromEntries(Object.entries(bg).filter(([, b]) => b.endedAt === undefined || now - b.endedAt < BG_KEEP_MS))

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const newRun = (id: string, now: number, over: Partial<Run> = {}): Run => ({
  id,
  type: id === MAIN ? 'principal' : '?',
  description: id === MAIN ? 'Sessão principal' : '',
  model: '',
  startedAt: now,
  steps: 0,
  tools: 0,
  byModel: {},
  added: 0,
  removed: 0,
  files: [],
  ...over,
})

/** Custo estimado; `unpriced` lista os modelos sem regra em prices.ts. */
export const costOf = (run: Run) => {
  let usd = 0
  const unpriced: string[] = []
  for (const [model, t] of Object.entries(run.byModel)) {
    const p = priceOf(model, run.startedAt)?.price
    if (!p) {
      unpriced.push(model)
      continue
    }
    usd += (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6
  }
  return { usd, unpriced }
}

const totalTokens = (run: Run) =>
  Object.values(run.byModel).reduce((s, t) => s + t.input + t.output + t.cacheRead + t.cacheWrite, 0)

/** Linhas +/- de um resultado de Edit ou Write. */
export const diffOf = (result: unknown): { file?: string; added: number; removed: number } => {
  const r = (result ?? {}) as {
    filePath?: string
    gitDiff?: { additions: number; deletions: number }
    structuredPatch?: { lines: string[] }[]
  }
  if (r.gitDiff) return { file: r.filePath, added: r.gitDiff.additions, removed: r.gitDiff.deletions }
  let added = 0
  let removed = 0
  for (const hunk of r.structuredPatch ?? [])
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  return { file: r.filePath, added, removed }
}

// ---- Gemini (script/gemini-dev) ------------------------------------------

/** Mesmo nome limpo que o script usa nos arquivos de tmp/gemini-dev. */
export const safeName = (s: string) =>
  s
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/** Reconhece uma chamada de verdade ao script (não `cat script/gemini-dev | …`) e diz tarefa, esforço e modelo. */
export const geminiCall = (command: string) => {
  const arg = '([^\\s|;&<>]+)'
  const m = command.match(
    new RegExp(`(?:^|[\\s;&|(])(?:\\./)?script/gemini-dev\\s+${arg}\\s+([^\\s|;&<>]+\\.md)(?:\\s+${arg})?(?:\\s+${arg})?`),
  )
  if (!m) return undefined
  const name = safeName(m[1].replace(/^['"]|['"]$/g, ''))
  if (!name) return undefined
  const fromEnv = command.match(/GEMINI_ESFORCO=(leve|pesado)/)?.[1]
  const effort = m[4] === 'leve' || m[4] === 'pesado' ? m[4] : (fromEnv ?? 'leve')
  const forced = command.match(/GEMINI_MODEL=([^\s'"]+)/)?.[1]
  return {
    name,
    taskPath: m[2],
    effort,
    model: forced ?? (effort === 'pesado' ? 'gemini-4-argon' : 'gemini-3.8-flash'),
  }
}

export type Flow = {
  actions: number
  last?: { text: string; at: number }
  files: string[]
  byModel: Record<string, Tokens>
  model?: string
  status?: string
  startAt?: number
  endAt?: number
}

const base = (p: string) => p.split('/').pop() || p
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** O que o Gemini está fazendo, em português, a partir de uma ferramenta dele. */
export const describeAction = (tool: string, params: Record<string, unknown>) => {
  const s = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '')
  const file = s('file_path') || s('path') || s('dir_path')
  switch (tool) {
    case 'read_file':
    case 'read_many_files':
      return `Lendo ${base(file) || 'arquivos'}`
    case 'write_file':
      return `Criando ${base(file)}`
    case 'replace':
      return `Editando ${base(file)}`
    case 'run_shell_command':
      return `Rodando ${clip(s('command').replace(/\s+/g, ' '), 64)}`
    case 'list_directory':
      return `Listando ${file || '.'}`
    case 'grep_search':
    case 'search_file_content':
      return `Buscando "${clip(s('pattern'), 36)}"`
    case 'glob':
      return `Procurando ${clip(s('pattern'), 40)}`
    default:
      return tool
  }
}

/** Lê o arquivo de eventos (stream-json) que o script grava em tmp/gemini-dev/<tarefa>.jsonl. */
export const parseFlow = (text: string): Flow => {
  const flow: Flow = { actions: 0, files: [], byModel: {} }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev: Record<string, any>
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(ev.timestamp ?? '') || 0
    if (ev.type === 'init') {
      flow.model = ev.model
      flow.startAt = at
    }
    else if (ev.type === 'tool_use') {
      flow.actions++
      flow.last = { text: describeAction(String(ev.tool_name), ev.parameters ?? {}), at }
      const f = ev.parameters?.file_path
      if ((ev.tool_name === 'write_file' || ev.tool_name === 'replace') && typeof f === 'string' && !flow.files.includes(f))
        flow.files.push(f)
    } else if (ev.type === 'result') {
      flow.status = String(ev.status ?? 'success')
      flow.endAt = at
      for (const [model, m] of Object.entries<Record<string, number>>(ev.stats?.models ?? {})) {
        const cached = m.cached ?? 0
        flow.byModel[model] = {
          input: m.input ?? Math.max(0, (m.input_tokens ?? 0) - cached),
          output: m.output_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: 0,
        }
      }
    }
  }
  return flow
}

export type Status = { exit: number; files: string[]; added: number; removed: number }

/** Lê o tmp/gemini-dev/<tarefa>.status.json que o script grava ao terminar. */
export const parseStatus = (text: string): Status | undefined => {
  try {
    const s = JSON.parse(text) as Partial<Status>
    return { exit: s.exit ?? 0, files: s.files ?? [], added: s.added ?? 0, removed: s.removed ?? 0 }
  } catch {
    return undefined
  }
}

/** Junta o que o arquivo de eventos e o status final dizem sobre a linha. */
export const mergeFlow = (run: Run, flow?: Flow, st?: Status): Run => {
  if (!flow && !st) return run
  const out: Run = {
    ...run,
    model: run.model || flow?.model || '',
    actions: flow ? flow.actions : run.actions,
    lastAction: flow?.last?.text ?? run.lastAction,
    lastActionAt: flow?.last?.at ?? run.lastActionAt,
    byModel: flow && Object.keys(flow.byModel).length ? flow.byModel : run.byModel,
    files: st ? st.files : (flow?.files ?? run.files),
  }
  if (st) {
    out.added = st.added
    out.removed = st.removed
    out.exit = st.exit
  } else if (flow?.status && out.exit === undefined) out.exit = flow.status === 'success' ? 0 : 1
  if ((st || flow?.status) && out.endedAt === undefined) out.endedAt = flow?.endAt || run.startedAt
  return out
}

export type GeminiState = 'running' | 'completed' | 'failed' | 'stale'

export const stateOf = (run: Run, now: number): GeminiState => {
  if (run.endedAt !== undefined || run.exit !== undefined) return run.exit ? 'failed' : 'completed'
  return now - (run.activityAt ?? run.lastActionAt ?? run.startedAt) > STALE_MS ? 'stale' : 'running'
}

type Entry = { name: string; mtimeMs: number; size: number }
const MAX_AGE_MS = 12 * 60 * 60 * 1000

/** Nomes das tarefas (arquivos .jsonl ou .log de tmp/gemini-dev) mexidas nas últimas 12 h. */
export const recentTasks = (entries: { name: string; mtimeMs: number }[], now: number) => {
  const seen = new Map<string, number>()
  for (const f of entries) {
    const m = f.name.match(/^(.+)\.(jsonl|log)$/)
    if (m) seen.set(m[1], Math.max(seen.get(m[1]) ?? 0, f.mtimeMs))
  }
  return [...seen].filter(([, t]) => now - t < MAX_AGE_MS).map(([name]) => name)
}

/** Raiz do repositório: num worktree, o .git é um arquivo que aponta para o clone principal, onde o script grava tmp/gemini-dev. */
const repoRoot = async ($: EngineInterface) => {
  try {
    const m = String(await $.fs.read('.git')).match(/^gitdir:\s*(.+?)\/\.git\/worktrees\//)
    if (m) return m[1]
  } catch {}
  return '.'
}

const readText = async ($: EngineInterface, path: string) => {
  try {
    return String(await $.fs.read(path))
  } catch {
    return undefined
  }
}

/** Título do card: a linha "Tarefa: …" ou "Título: …", senão a primeira linha com texto que não seja só "Nome: …". */
export const titleOf = (text: string) => {
  const lines = text
    .split('\n')
    .map(l => l.replace(/^[#>*\-\s]+/, '').trim())
    .filter(l => l.length > 0)
  const labelled = lines.map(l => l.match(/^(?:tarefa|título|titulo)\s*:\s*(.+)$/i)?.[1]).find(Boolean)
  const first = labelled ?? lines.find(l => !/^nome\s*:/i.test(l))
  return first ? clip(first, 90) : undefined
}

/** Título (primeira linha com texto) e hora do arquivo da tarefa: na raiz do repositório ou, se o Claude o escreveu num worktree, no tmp/gemini-dev da pasta atual. */
const readTask = async ($: EngineInterface, dir: string, name: string) => {
  for (const path of [`${dir}/${name}.md`, `tmp/gemini-dev/${name}.md`]) {
    const text = await readText($, path)
    if (text === undefined) continue
    let mtime: number | undefined
    try {
      mtime = (await $.fs.stat(path)).mtimeMs
    } catch {}
    return { title: titleOf(text), mtime }
  }
  return { title: undefined, mtime: undefined }
}

/** "2-03:04:05", "03:04:05" ou "04:05" (o etime do ps) em segundos. */
export const etimeSeconds = (etime: string) => {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** Tarefas com um script/gemini-dev rodando agora, de qualquer sessão: nome → início (ms). undefined se o ps falhar. */
const aliveTasks = async ($: EngineInterface, now: number) => {
  try {
    const r = await $.process.run(['ps', '-axo', 'etime=,args='], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return undefined
    const alive = new Map<string, number>()
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*(\S+)\s+(.*)$/)
      const call = m?.[2].match(/(?:^|\s)(?:\.\/)?script\/gemini-dev\s+(\S+)\s+\S+\.md/)
      const secs = m ? etimeSeconds(m[1]) : undefined
      if (!call || secs === undefined) continue
      const name = safeName(call[1])
      alive.set(name, Math.min(alive.get(name) ?? Infinity, now - secs * 1000))
    }
    return alive
  } catch {
    return undefined
  }
}

/** Monta as tarefas do Gemini lendo tmp/gemini-dev e os processos vivos: vale para qualquer tarefa, de qualquer sessão, em worktree ou não. */
const scanGemini = async ($: EngineInterface, now: number) => {
  const dir = `${await repoRoot($)}/tmp/gemini-dev`
  let entries: Entry[]
  try {
    entries = (await $.fs.list(dir)).map(f => ({ name: f.name, mtimeMs: f.mtimeMs, size: f.size }))
  } catch {
    return []
  }
  const alive = await aliveTasks($, now)
  const mtime = (file: string) => entries.find(f => f.name === file)?.mtimeMs
  const size = (file: string) => entries.find(f => f.name === file)?.size ?? 0
  const names = new Set([...recentTasks(entries, now), ...(alive?.keys() ?? [])])
  return Promise.all(
    [...names].map(async name => {
      const [flowText, statusText, metaText, task] = await Promise.all([
        readText($, `${dir}/${name}.jsonl`),
        readText($, `${dir}/${name}.status.json`),
        readText($, `${dir}/${name}.meta.json`),
        readTask($, dir, name),
      ])
      const flow = flowText ? parseFlow(flowText) : undefined
      const st = statusText ? parseStatus(statusText) : undefined
      let meta: { model?: string; effort?: string } = {}
      try {
        meta = metaText ? JSON.parse(metaText) : {}
      } catch {}
      const logAt = mtime(`${name}.log`)
      const flowAt = mtime(`${name}.jsonl`)
      const procStart = alive?.get(name)
      const legacy = !flow && !st
      const activity = Math.max(flowAt ?? 0, logAt ?? 0, flow?.last?.at ?? 0) || undefined
      let run = newRun(`gemini:${name}`, procStart ?? flow?.startAt ?? task.mtime ?? flowAt ?? logAt ?? now, {
        type: 'gemini',
        description: name,
        title: task.title,
        external: true,
        model: meta.model ?? '',
        effort: meta.effort,
        activityAt: activity,
      })
      run = mergeFlow(run, flow, st)
      if (procStart !== undefined) run = { ...run, endedAt: undefined, exit: undefined, activityAt: now }
      else if (alive !== undefined && run.endedAt === undefined) {
        const lastSign = activity ?? run.startedAt
        run = { ...run, endedAt: lastSign, exit: legacy && size(`${name}.log`) > 0 ? 0 : 1 }
      } else if (alive === undefined && legacy && logAt !== undefined && size(`${name}.log`) > 0 && now - logAt > 90_000)
        run = { ...run, endedAt: logAt, exit: 0 }
      return { run, state: stateOf(run, now) }
    }),
  )
}

/** Execução do CLI que é a mesma de uma tarefa do script (projeto gemini-<tarefa> ou começou junto). */
export const sameAsTask = (cli: Run, tasks: Run[]) =>
  tasks.some(t => cli.description === `gemini-${t.description}` || Math.abs(cli.startedAt - t.startedAt) < 60_000)

/** Chamada direta ao Gemini CLI na posição de comando (`gemini -m …`, `env X=1 gemini …`), não o script nem uma menção ao nome. */
export const cliCall = (command: string) =>
  /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:\w+=\S*\s+)*(?:(?:env|nohup|exec|time)\s+|timeout\s+\S+\s+)*(?:\S*\/)?gemini\s/.test(command)

/** Uma execução do Gemini começou por um comando desta sessão. */
export const fromHere = (run: Run, mine: Launch[]) => {
  if (run.id.startsWith('gemini-cli:'))
    return mine.some(l => !l.task && run.startedAt >= l.at - 5000 && run.startedAt <= Math.max(l.end ?? l.at, l.at) + 60_000)
  return mine.some(l => l.task === run.description)
}

/** Tarefas do script/gemini-dev mais as execuções diretas do Gemini CLI, sem repetir, só as que esta sessão começou. */
const allGemini = async ($: EngineInterface, now: number, mine: Launch[]) => {
  if (mine.length === 0) return []
  const tasks = (await scanGemini($, now)).filter(t => fromHere(t.run, mine))
  const cli = (await scanGeminiCli($, now, describeAction)).filter(r => fromHere(r, mine) && !sameAsTask(r, tasks.map(t => t.run)))
  return [...tasks, ...cli.map(run => ({ run, state: stateOf(run, now) }))]
}

const brl = (n: number) => n.toFixed(2).replace('.', ',')
const usd = (n: number) => (n > 0 && n < 0.01 ? 'US$ <0,01' : `US$ ${brl(n)}`)
const kTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : `${n}`
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
const EFFORT: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'muito alto', max: 'máximo' }
/** "esforço alto"; vazio quando não se sabe. Gemini (leve/pesado) passa como veio. */
export const effortLabel = (effort?: string) => (effort ? `esforço ${EFFORT[effort] ?? effort}` : '')
// ---- Limites do Claude (conta toda) ---------------------------------------

const BAR_WIDTH = 24
const LIMITS: Record<string, { label: string; order: number }> = {
  five_hour: { label: 'Limite da sessão (5 h)', order: 0 },
  seven_day: { label: 'Limite semanal', order: 1 },
  spend_limit: { label: 'Limite de gasto', order: 2 },
}
export const limitLabel = (kind: string) => LIMITS[kind]?.label ?? kind
const limitOrder = (kind: string) => LIMITS[kind]?.order ?? 9

/** Barra de texto: "████████░░░░░░░░" com `width` blocos, travada entre 0 e 100%. */
export const bar = (percent: number, width: number) => {
  const full = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}
export const barColor = (percent: number) => (percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green')

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** "reinicia às 15:30 · em 2 h 10 min"; a mais de um dia, "reinicia qui 09:00 · em 3 d 4 h". */
export const resetText = (iso: string, now: number) => {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  const mins = Math.max(0, Math.round((at - now) / 60000))
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const rest = mins % 60
  const inText = days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${rest} min` : `${rest} min`
  const when = days > 0 || new Date(now).getDate() !== d.getDate() ? `${WEEKDAYS[d.getDay()]} ${hhmm(d)}` : `às ${hhmm(d)}`
  return `reinicia ${when} · em ${inText}`
}

/** 1155 → "1.155" */
export const thousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')


/**
 * Custo da sessão principal pelo /cost: o ledger soma tudo que o Claude gastou
 * (principal + subagentes), então a principal é o total menos os subagentes.
 * Cobre também o que a principal gastou antes do mod carregar.
 */
export const mainFromLedger = (ledger: number | undefined, subsUsd: number) =>
  ledger === undefined ? undefined : Math.max(0, ledger - subsUsd)


type Item = { kind: 'dev' | 'sub' | 'bg'; run: Run; state: GeminiState }

/** O subagente de Claude que só despacha o Gemini já é a tarefa do Gemini: não vira card à parte. */
export const isWrapper = (r: Run) => r.type === 'gemini-dev' || /^(run )?gemini\b/i.test(r.description)

let ticker: Timer | undefined
let lastReap = 0

/** Confere com o ps o que o painel dá como rodando em segundo plano e fecha o que já morreu. */
const reapActivity = async ($: EngineInterface, now: number, force = false) => {
  if (!force && now - lastReap < 10_000) return
  lastReap = now
  const act = await read($, activity)
  if (!Object.values(act.bg).some(b => b.endedAt === undefined)) return
  let psOut: string | undefined
  try {
    const r = await $.process.run(['ps', '-axo', 'args='], { timeoutMs: 5000 })
    if (r.exitCode === 0) psOut = r.stdout
  } catch {}
  await update($, activity, a => {
    const bg = reapBg(a.bg, now, psOut)
    return bg === a.bg ? a : { ...a, bg }
  })
}

/** As mescladas guardadas, atualizadas com o que `kids` traz agora. */
export const withMerged = (saved: Record<string, Merged>, kids: Kid[]) => {
  const out = { ...saved }
  for (const k of kids)
    if (k.merged && k.figures) out[k.id] = { id: k.id, title: k.title, usd: k.figures.usd, tokens: k.figures.tokens }
  return out
}

/** Guarda as mescladas no estado da sessão, para não sumirem se a aninhada for apagada. */
async function foldMerged($: EngineInterface) {
  try {
    const kids = await sessionKids($, await $.clock.now())
    if (!kids.some(k => k.merged && k.figures)) return
    const saved = await read($, merged)
    const next = withMerged(saved, kids)
    if (JSON.stringify(next) !== JSON.stringify(saved)) await update($, merged, m => withMerged(m, kids))
  } catch {}
}

/** Números desta sessão para a sessão mãe: custo pelo /cost, tokens e diff de tudo que o Claude fez aqui. */
const publishOwn = async ($: EngineInterface, force = false) => {
  try {
    const all = Object.values(await read($, runs)).filter(r => !r.external)
    const main = all.find(r => r.id === MAIN)
    const ledger = (await $.session.usage()).cost?.usd
    await publishSelf(
      $,
      {
        usd: ledger ?? all.reduce((s, r) => s + costOf(r).usd, 0),
        tokens: all.reduce((s, r) => s + totalTokens(r), 0),
        added: all.reduce((s, r) => s + r.added, 0),
        removed: all.reduce((s, r) => s + r.removed, 0),
        model: main?.model,
        effort: main?.effort ?? (await $.env.get('CLAUDE_EFFORT')),
      },
      force,
    )
  } catch {}
}

const startTicker = ($: EngineInterface) => {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      try {
        const now = await $.clock.now()
        let all = await read($, runs)
        // Subagente que o motor já não lista: fecha, para o ticker não ficar vivo por causa dele.
        const listed = new Set((await $.agent.list()).map(a => a.id))
        const orphan = Object.values(all).filter(r => !r.external && r.id !== MAIN && r.endedAt === undefined && !listed.has(r.id) && now - r.startedAt > 60_000)
        if (orphan.length) {
          await update($, runs, a => Object.fromEntries(Object.entries(a).map(([k, r]) => [k, orphan.some(o => o.id === k) && r.endedAt === undefined ? { ...r, endedAt: now } : r])))
          all = await read($, runs)
        }
        const subs =Object.values(all).some(r => !r.external && r.id !== MAIN && r.endedAt === undefined)
        const act = await read($, activity)
        const busy = act.turnAt !== undefined || Object.values(act.bg).some(b => b.endedAt === undefined)
        const live = subs || busy || kidsLive() || (await allGemini($, now, await read($, launches))).some(g => g.state === 'running')
        await reapActivity($, now)
        await foldMerged($)
        await refreshPr($)
        await refreshBranch($)
        // PR aberto mantém o timer vivo só para o gh (a cada 30 s), sem redesenhar a cada 2 s.
        const prOpen = Object.values(await read($, prsState)).some(p => p.state === 'OPEN')
        if (!live) {
          if (!prOpen) {
            ticker?.cancel()
            ticker = undefined
          }
          return
        }
        await update($, runs, a => ({ ...a }))
      } catch {}
    })()
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'painel', description: 'Abre o Painel da sessão: limites, PRs, subagentes e custo' })
    await $.command.register({ name: 'subagentes', description: 'Abre o Painel da sessão (nome antigo)' })
    void $.ui.open({ id: PANE, title: 'Painel da sessão' })
    startTicker($)
    void $.clock.now().then(n => reapActivity($, n, true)).catch(() => {})
    void pruneStore($).catch(() => {})
    void publishOwn($, true)
    void refreshPr($, true).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'subagentes' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Painel da sessão' })
    return { text: 'Painel aberto.' }
  })
  on('command.run', { command: 'painel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Painel da sessão' })
    return { text: 'Painel aberto.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    // O registro nunca pode derrubar o spawn: erro aqui só perde a linha do painel.
    if ('agentId' in out && out.agentId)
      try {
        const id = out.agentId
        const now = await $.clock.now()
        await update($, runs, all => ({
          ...all,
          [id]: newRun(id, now, {
            ...all[id],
            type: e.subagentType || 'general-purpose',
            description: e.description ?? '',
            model: out.model,
          }),
        }))
        startTicker($)
      } catch {}
    return out
  })

  // turn.step é streaming: repassa os pedaços e lê o resultado final.
  on('turn.step', async function* ($, e, next) {
    const out = yield* next(e)
    const usage = out.usage
    const id = e.agentId ?? MAIN
    const now = await $.clock.now()
    await update($, runs, all => {
      const run = all[id] ?? newRun(id, now)
      const byModel = { ...run.byModel }
      if (usage) {
        const t = byModel[usage.model] ?? zero()
        byModel[usage.model] = {
          input: t.input + usage.input_tokens,
          output: t.output + usage.output_tokens,
          cacheRead: t.cacheRead + usage.cache_read_input_tokens,
          cacheWrite: t.cacheWrite + usage.cache_creation_input_tokens,
        }
      }
      return { ...all, [id]: { ...run, steps: run.steps + 1, byModel, model: usage?.model ?? run.model, effort: typeof e.effort === 'string' ? e.effort : run.effort } }
    })
    void publishOwn($)
    return out
  })

  on('tool.call', async ($, e, next) => {
    const script = e.tool === 'Bash' ? geminiCall(e.command) : undefined
    const isGemini = !!script || (e.tool === 'Bash' && cliCall(e.command))
    let at = 0
    if (isGemini)
      try {
        at = await $.clock.now()
        const launch: Launch = script ? { at, task: script.name } : { at }
        await update($, launches, all => [...all.filter(l => at - l.at < 24 * 60 * 60 * 1000), launch])
        startTicker($)
      } catch {}
    // A ferramenta que a principal está rodando agora aparece no card dela.
    let toolAt = 0
    if (e.agentId === undefined)
      try {
        toolAt = await $.clock.now()
        const label = toolLabel(e.tool, e as unknown as Record<string, unknown>)
        await update($, activity, a => ({ ...a, tool: { label, at: toolAt } }))
        startTicker($)
      } catch {}
    const out = await next(e)
    try {
      const now = await $.clock.now()
      const bgId =
        e.tool === 'Bash' && 'result' in out && out.result
          ? (out.result as { backgroundTaskId?: string }).backgroundTaskId
          : undefined
      const stopped = e.tool === 'TaskStop' ? (e.task_id ?? e.shell_id) : undefined
      if (toolAt || bgId || stopped)
        await update($, activity, a => {
          let bg = a.bg
          if (bgId && e.tool === 'Bash') bg = { ...bg, [bgId]: { id: bgId, label: e.description || cmdLabel(e.command), at: now, command: e.command } }
          if (stopped) bg = endBg(bg, stopped, now, 'stopped')
          return { ...a, bg, tool: a.tool && a.tool.at === toolAt ? undefined : a.tool }
        })
      if (bgId) startTicker($)
    } catch {}
    if (e.tool === 'Bash' && /\bgh\s+pr\b|\bgit\s+push\b/.test(e.command)) {
      const text = 'result' in out && out.result ? JSON.stringify(out.result) : ''
      void refreshPr($, true, prUrls(text)).catch(() => {})
    }
    if (isGemini)
      try {
        const end = await $.clock.now()
        await update($, launches, all => all.map(l => (l.at === at ? { ...l, end } : l)))
        startTicker($)
      } catch {}
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') void refreshBranch($).catch(() => {})
    try {
      const id = e.agentId ?? MAIN
      const isEdit = e.tool === 'Edit' || e.tool === 'Write'
      const d = isEdit && 'result' in out && out.result && !out.isError ? diffOf(out.result) : undefined
      const now = await $.clock.now()
      await update($, runs, all => {
        const run = all[id] ?? newRun(id, now)
        const files = d?.file && !run.files.includes(d.file) ? [...run.files, d.file] : run.files
        return {
          ...all,
          [id]: {
            ...run,
            tools: run.tools + 1,
            added: run.added + (d?.added ?? 0),
            removed: run.removed + (d?.removed ?? 0),
            files,
          },
        }
      })
    } catch {}
    return out
  })

  on('turn.start', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined)
      try {
        const now = await $.clock.now()
        await update($, activity, a => ({ ...a, turnAt: a.turnAt ?? now }))
        startTicker($)
      } catch {}
    return out
  })

  // Uma tarefa em segundo plano que terminou chega como notificação.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification')
      try {
        const n = taskNotice(e.text)
        const now = await $.clock.now()
        if (n) await update($, activity, a => ({ ...a, bg: endBg(a.bg, n.id, now, n.status) }))
      } catch {}
    return next(e)
  })

  // Quando a principal para, o motor lista o que ainda roda em segundo plano: o resto acabou.
  on('classic.Stop', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const inFlight = (e.background_tasks ?? []).filter(t => t.type !== 'subagent')
      await update($, activity, a => {
        const alive = new Set(inFlight.map(t => t.id))
        let bg = { ...a.bg }
        for (const t of inFlight)
          bg[t.id] = bg[t.id]
            ? { ...bg[t.id], seenAt: now, command: bg[t.id].command ?? t.command }
            : { id: t.id, label: t.description || cmdLabel(t.command ?? t.type), at: now, seenAt: now, command: t.command }
        for (const b of Object.values(bg)) if (b.endedAt === undefined && !alive.has(b.id)) bg = endBg(bg, b.id, now, 'completed')
        return { ...a, bg: pruneBg(bg, now) }
      })
      await reapActivity($, now, true)
    } catch {}
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    const id = e.agentId
    if (id) {
      const now = await $.clock.now()
      await update($, runs, all => (all[id] ? { ...all, [id]: { ...all[id], endedAt: now } } : all))
    } else {
      try {
        await update($, activity, a => ({ ...a, turnAt: undefined, tool: undefined }))
      } catch {}
      void publishOwn($, true)
      void foldMerged($)
      void refreshPr($).catch(() => {})
    }
    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Link, Button } = el
    const prs = Object.values(await read($, prsState)).sort((a, b) => (a.state === 'OPEN' ? 0 : 1) - (b.state === 'OPEN' ? 0 : 1) || b.number - a.number)
    const branch = await read($, branchState)
    const Svg = 'Svg' in el ? el.Svg : undefined
    const all = await read($, runs)
    const now = await $.clock.now()
    const live = new Map<string, AgentInfo>((await $.agent.list()).map(a => [a.id, a]))
    const usage = await $.session.usage()
    const ledger = usage.cost?.usd

    const rows = Object.values(all)
    const devs: Item[] = (await allGemini($, now, await read($, launches))).map(g => ({ kind: 'dev', run: g.run, state: g.state }))
    const subs: Item[] = rows
      .filter(r => !r.external && r.id !== MAIN && !isWrapper(r))
      .map(r => {
        // Fora da lista do motor há mais de 1 min: já acabou, mesmo que o aviso de fim tenha se perdido.
        const gone = r.endedAt === undefined && !live.has(r.id) && now - r.startedAt > 60_000
        const status = live.get(r.id)?.status ?? (r.endedAt || gone ? 'completed' : 'running')
        const state: GeminiState = status === 'completed' ? 'completed' : status === 'failed' || status === 'killed' ? 'failed' : 'running'
        return { kind: 'sub', run: r, state }
      })
    const act = await read($, activity)
    const bgs: Item[] = Object.values(act.bg).map(b => ({
      kind: 'bg',
      run: newRun(b.id, b.at, { type: 'bg', description: b.label, endedAt: b.endedAt }),
      state: b.endedAt === undefined ? 'running' : b.status === 'completed' ? 'completed' : 'failed',
    }))
    const mainBusy = act.turnAt !== undefined || act.tool !== undefined
    const items = [...devs, ...subs, ...bgs]

    const running = items.filter(i => i.state === 'running').sort((a, b) => b.run.startedAt - a.run.startedAt)
    const finished = items.filter(i => i.state !== 'running').sort((a, b) => (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0))
    const gemUsd = devs.reduce((s, g) => s + costOf(g.run).usd, 0)
    const gemTokens = devs.reduce((s, g) => s + totalTokens(g.run), 0)
    const unpriced = [...new Set(devs.flatMap(g => costOf(g.run).unpriced))]

    const main = rows.find(r => r.id === MAIN) ?? newRun(MAIN, usage.startedAt)
    const subsUsd = rows.filter(r => !r.external && r.id !== MAIN).reduce((s, r) => s + costOf(r).usd, 0)
    const subsTokens = rows.filter(r => !r.external && r.id !== MAIN).reduce((s, r) => s + totalTokens(r), 0)
    const mainTokens = rows.filter(r => r.id === MAIN).reduce((s, r) => s + totalTokens(r), 0)
    // Sessões que esta começou: aninhadas aparecem à parte; mescladas somam aqui.
    const kids = await sessionKids($, now)
    const nested = kids.filter(isNested)
    // O desenho não grava estado (o motor recusa): mostra o guardado somado ao que
    // acabou de ler; foldMerged grava no fim de cada resposta e no timer.
    const mergedList = Object.values(withMerged(await read($, merged), kids))
    const mergedUsd = mergedList.reduce((s, m) => s + m.usd, 0)
    const mergedTokens = mergedList.reduce((s, m) => s + m.tokens, 0)
    const nestedUsd = nested.reduce((s, k) => s + (k.figures?.usd ?? 0), 0)
    const nestedTokens = nested.reduce((s, k) => s + (k.figures?.tokens ?? 0), 0)
    const mainEffort = main.effort ?? (await $.env.get('CLAUDE_EFFORT'))
    // Sessão (5 h) primeiro, semanal depois, o resto (limite de gasto) no fim.
    const limits = [...usage.rateLimits].sort((a, b) => limitOrder(a.kind) - limitOrder(b.kind))
    const mainEst = costOf(main)
    const mainLedger = mainFromLedger(ledger, subsUsd)
    const mainUsd = mainLedger ?? mainEst.usd
    const totalUsd = (ledger ?? mainEst.usd + subsUsd) + gemUsd
    // Diff da sessão: o que a principal e os subagentes do Claude editaram.
    const diff = rows
      .filter(r => !r.external)
      .reduce((s, r) => ({ added: s.added + r.added, removed: s.removed + r.removed }), { added: 0, removed: 0 })

    const dot = (s: GeminiState) => (s === 'running' ? 'warning' : s === 'completed' ? 'success' : 'error')
    const label = (s: GeminiState) => (s === 'running' ? 'rodando' : s === 'completed' ? 'pronta' : s === 'failed' ? 'falhou' : 'sem sinal')
    const limitColor = (p: number) => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'suggestion')

    // Mesmo vocabulário do painel lateral do app: seções com título simples,
    // linhas rótulo à esquerda e valor apagado à direita, divisória fina entre seções.
    const RULE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1" viewBox="0 0 2000 1" preserveAspectRatio="none"><rect width="2000" height="1" fill="#888888" fill-opacity="0.3"/></svg>'
    const Divider = () =>
      Svg ? (
        <Box marginY="sm">
          <Svg source={RULE} alt="divisória" height={1} />
        </Box>
      ) : (
        <Box marginY="xs">
          <Text dimColor wrap="truncate">
            {'─'.repeat(200)}
          </Text>
        </Box>
      )

    /** Barrinha curta ao lado da porcentagem, como a do Contexto no painel do app. */
    const meterHex = (p: number) => (p >= 90 ? '#e5534b' : p >= 70 ? '#d99a2b' : '#5b8def')
    const Meter = (pct: number) => {
      if (!Svg) return <Text size="footnote" color={limitColor(pct)}>{bar(pct, 8)}</Text>
      const w = Math.max(3, Math.round((pct / 100) * 48))
      const src = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="6" viewBox="0 0 48 6"><rect width="48" height="6" rx="3" fill="#888888" fill-opacity="0.35"/><rect width="${w}" height="6" rx="3" fill="${meterHex(pct)}"/></svg>`
      return <Svg source={src} alt={`${pct}% usado`} width={48} height={6} />
    }

    const svg = (body: string, color: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    const DIFF_ICON = '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M8 4.8v4M6 6.8h4M6 11h4"/>'
    const PR_OPEN = '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8"/><path d="M12 10.9V7.5a2 2 0 0 0-2-2H7.5"/><path d="M9 4l-1.5 1.5L9 7"/>'
    const PR_DRAFT = '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8"/><path d="M12 4v.5M12 7v.5M12 10v.5"/>'
    const PR_MERGED = '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="8.5" r="1.6"/><path d="M4 5.1v5.8"/><path d="M4 5.1c0 2.4 2.2 3.4 6.4 3.4"/>'
    const PR_CLOSED = '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8"/><path d="M10.5 3.5l3 3M13.5 3.5l-3 3"/>'
    const prIcon = (p: Pr) =>
      p.state === 'MERGED'
        ? svg(PR_MERGED, '#a371f7')
        : p.state === 'CLOSED'
          ? svg(PR_CLOSED, '#e5534b')
          : p.draft
            ? svg(PR_DRAFT, '#8a8a8a')
            : svg(PR_OPEN, '#3fb950')
    const menu = await read($, menuState)
    const away = await read($, awayState)
    const showBranch = !!branch && !branch.hasPr && (branch.canCreate || branch.added + branch.removed > 0)
    const Head = (title: string, aside?: string, asideDot?: string) => (
      <Box justifyContent="space-between" alignItems="center" gap="sm">
        <Text weight="medium">{title}</Text>
        {aside && (
          <Box alignItems="center" gap="xs">
            {asideDot && (
              <Text size="caption" color={asideDot}>
                ●
              </Text>
            )}
            <Text size="footnote" dimColor>
              {aside}
            </Text>
          </Box>
        )}
      </Box>
    )

    const Diff = (added: number, removed: number) => (
      <Box gap="xs">
        <Text size="footnote" color="success" tabular>{`+${thousands(added)}`}</Text>
        <Text size="footnote" color="error" tabular>{`−${thousands(removed)}`}</Text>
      </Box>
    )

    const Row = (left: string, right?: string, strong = false) => (
      <Box justifyContent="space-between" alignItems="center" gap="sm">
        <Text size="footnote" weight={strong ? 'medium' : 'regular'} wrap="truncate">
          {left}
        </Text>
        {right && (
          <Text size="footnote" dimColor={!strong} weight={strong ? 'medium' : 'regular'} tabular>
            {right}
          </Text>
        )}
      </Box>
    )

    const Note = (text: string, color?: string) => (
      <Text size="caption" dimColor={!color} color={color}>
        {text}
      </Text>
    )

    /** Uma linha por tarefa: bolinha de status, nome e tempo; embaixo, os números apagados. */
    const ItemRow = (g: Item) => {
      const { run, state, kind } = g
      const elapsed = dur((run.endedAt ?? now) - run.startedAt)
      const right = state === 'running' ? elapsed : `${label(state)} · ${elapsed}`
      let details: string
      if (kind === 'bg') details = 'segundo plano'
      else {
        const c = costOf(run)
        const tokens = totalTokens(run)
        const model =
          kind === 'dev'
            ? join(run.model || 'Gemini', effortLabel(run.effort))
            : join(priceOf(run.model)?.label ?? (run.model || 'Claude'), effortLabel(run.effort))
        const tok = tokens > 0 ? `${kTok(tokens)} tokens` : kind === 'dev' && state === 'running' ? 'tokens no fim' : undefined
        const money = c.unpriced.length ? 'sem preço' : tokens > 0 ? usd(c.usd) : undefined
        details = join(model, tok, money)
      }
      const edits = kind !== 'bg' && (run.added > 0 || run.removed > 0)
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between" alignItems="center" gap="sm">
            <Box alignItems="center" gap="xs" flexShrink={1} flexGrow={1} minWidth={0}>
              <Text size="caption" color={dot(state)}>
                ●
              </Text>
              <Text size="footnote" wrap="truncate">
                {run.description || run.id}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text size="footnote" dimColor tabular>
                {right}
              </Text>
            </Box>
          </Box>
          <Box paddingLeft={2} flexDirection="column">
            {run.title && run.title !== run.description && Note(run.title)}
            <Box justifyContent="space-between" gap="sm" flexWrap="wrap">
              {Note(details)}
              {edits && Diff(run.added, run.removed)}
            </Box>
            {state === 'stale' && Note('Sem sinal há mais de 5 min. Pode ter sido interrompida.', 'error')}
          </Box>
        </Box>
      )
    }

    const modelLabel = priceOf(main.model || Object.keys(main.byModel)[0] || '')?.label ?? (main.model || 'Claude')
    const working = running.length > 0 || mainBusy

    return (
      <Box flexDirection="column" paddingY="xs">
        <Box flexDirection="column" gap="xs">
          {Head('Limites do Claude', 'conta toda')}
          {limits.length === 0 && Note('Sem leitura ainda: aparece depois da próxima resposta do modelo.')}
          {limits.map(l => {
            const pct = Math.min(100, Math.max(0, l.percentUsed))
            const pctText = `${String(l.percentUsed).replace('.', ',')}%`
            return (
              <Box flexDirection="column">
                <Box justifyContent="space-between" alignItems="center" gap="sm">
                  <Text size="footnote" wrap="truncate">
                    {limitLabel(l.kind)}
                  </Text>
                  <Box alignItems="center" gap="xs">
                    <Text size="footnote" dimColor tabular>
                      {pctText}
                    </Text>
                    {Meter(pct)}
                  </Box>
                </Box>
                {l.resetsAt && Note(resetText(l.resetsAt, now))}
              </Box>
            )
          })}
        </Box>
        {Divider()}

        {(prs.length > 0 || showBranch) && (
          <Box flexDirection="column" gap="sm">
            {Head('Alterações', prs.length > 1 ? `${prs.length} PRs` : undefined)}
            {showBranch && branch && (
              <Box justifyContent="space-between" alignItems="center" gap="sm">
                <Box gap="xs" alignItems="center" flexShrink={1} minWidth={0}>
                  <Box flexShrink={0}>
                    {Svg ? <Svg source={svg(DIFF_ICON, '#8a8a8a')} alt="alterações locais" width={16} height={16} /> : <Text dimColor>±</Text>}
                  </Box>
                  <Text size="footnote" wrap="truncate">
                    {branch.repo || branch.name}
                  </Text>
                  {Diff(branch.added, branch.removed)}
                </Box>
                {branch.canCreate && (
                  <Box flexShrink={0}>
                    <Button
                      key="create-pr"
                      label="Criar PR"
                      variant="secondary"
                      onPress={() => void $.prompt.submit({ text: 'cria o PR desta branch', asUser: true }).catch(() => {})}
                    />
                  </Box>
                )}
              </Box>
            )}
            {prs.map(p => {
              const st = prStatus(p)
              const open = p.state === 'OPEN'
              const menuOpen = menu === p.url
              const toggle = () => void update($, menuState, m => (m === p.url ? null : p.url)).catch(() => {})
              return (
                <Box key={p.url} flexDirection="column" gap="xs">
                  <Box alignItems="flex-start" gap="xs">
                    <Box flexShrink={0} paddingTop={0}>
                      {Svg ? <Svg source={prIcon(p)} alt={p.state === 'MERGED' ? 'PR mergeado' : 'pull request'} width={16} height={16} /> : <Text dimColor>⑂</Text>}
                    </Box>
                    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                      <Box justifyContent="space-between" alignItems="center" gap="xs">
                        <Box key={`title:${p.url}`} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                          <Link href={p.url}>
                            <Text size="footnote" wrap="truncate" color="text" hover={{ underline: true }}>
                              {p.title}
                            </Text>
                          </Link>
                        </Box>
                        <Box flexShrink={0}>
                          <Button key={`menu:${p.url}`} label="⋯" plain dimColor onPress={toggle} />
                        </Box>
                        {menuOpen && (
                          <Box
                            position="absolute"
                            top={1}
                            right={0}
                            flexDirection="column"
                            gap="xs"
                            minWidth={22}
                            borderStyle="round"
                            borderColor="subtle"
                            backgroundColor="inverseText"
                            paddingX="sm"
                            paddingY="xs"
                          >
                      <Link href={p.url} label="Abrir no GitHub" />
                      {open && !p.draft && (
                        <Button
                          key={`draft:${p.url}`}
                          label="Voltar pra rascunho"
                          plain
                          onPress={() => {
                            toggle()
                            void prAction($, p, ['pr', 'ready', p.url, '--undo'], 'Voltando pra rascunho o', 'voltou pra rascunho')
                          }}
                        />
                      )}
                      {open && p.failing === 0 && (
                        <Button
                          key={`ci2:${p.url}`}
                          label="Revisar o PR"
                          plain
                          onPress={() => {
                            toggle()
                            void $.prompt.submit({ text: `revisa o PR ${p.url}`, asUser: true }).catch(() => {})
                          }}
                        />
                      )}
                      <Button
                        key={`copy:${p.url}`}
                        label="Copiar link"
                        plain
                        onPress={press => {
                          toggle()
                          void $.ui.copy({ text: p.url, surface: press.surface }).catch(() => {})
                        }}
                      />
                          </Box>
                        )}
                      </Box>
                      <Box justifyContent="space-between" alignItems="center" gap="sm">
                        <Box gap="xs" alignItems="center" flexShrink={1} minWidth={0}>
                          <Text size="footnote" dimColor tabular wrap="truncate">{`${p.repo ? `${p.repo} ` : ''}#${p.number}`}</Text>
                          {open && Diff(p.added, p.removed)}
                        </Box>
                        {st && (
                          <Box gap="xs" alignItems="center" flexShrink={0}>
                            {st.dot && (
                              <Text size="caption" color={st.dot}>
                                ●
                              </Text>
                            )}
                            <Text size="footnote" color={st.dot ? undefined : st.color} dimColor={!!st.dot} tabular>
                              {st.text}
                            </Text>
                          </Box>
                        )}
                      </Box>
                    </Box>
                  </Box>
                  {open && (p.draft || p.failing > 0) && (
                    <Box gap="xs" flexWrap="wrap" paddingLeft={3}>
                      {p.draft && (
                        <Button
                          key={`ready:${p.url}`}
                          label="Marcar como pronto"
                          variant="secondary"
                          onPress={() => void prAction($, p, ['pr', 'ready', p.url], 'Marcando como pronto o', 'está pronto pra revisão')}
                        />
                      )}
                      {p.failing > 0 && (
                        <Button
                          key={`ci:${p.url}`}
                          label="Corrigir CI"
                          variant="secondary"
                          onPress={() =>
                            void $.prompt
                              .submit({ text: `o CI do PR ${p.url} está com ${p.failing} check(s) falhando. investiga e corrige`, asUser: true })
                              .catch(() => {})
                          }
                        />
                      )}
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}
        {(prs.length > 0 || showBranch) && Divider()}

        <Box flexDirection="column" gap="xs">
          {Head('Sessão principal', working ? 'trabalhando' : 'parado', working ? 'warning' : 'subtle')}
          {Row(join(modelLabel, effortLabel(mainEffort)), dur(now - usage.startedAt))}
          {Row(
            mainBusy
              ? join(
                  act.turnAt !== undefined ? `há ${dur(now - act.turnAt)}` : undefined,
                  act.tool ? `${act.tool.label} (${dur(now - act.tool.at)})` : 'pensando',
                )
              : 'esperando você',
          )}
        </Box>

        {Divider()}

        <Box flexDirection="column" gap="xs">
          {Head('Subagentes e tarefas', running.length > 0 ? `${running.length} rodando` : items.length > 0 ? `${items.length}` : undefined)}
          {items.length === 0 && Note('Nenhum subagente, tarefa em segundo plano ou do Gemini ainda.')}
          {running.map(ItemRow)}
          {finished.length > 0 && running.length > 0 && <Box marginTop="xs">{Note('Terminadas')}</Box>}
          {finished.slice(0, DONE_SHOWN).map(ItemRow)}
          {finished.length > DONE_SHOWN && Note(`e mais ${finished.length - DONE_SHOWN} anteriores`)}
        </Box>

        {(nested.length > 0 || mergedList.length > 0) && Divider()}
        {(nested.length > 0 || mergedList.length > 0) && (
          <Box flexDirection="column" gap="xs">
            {Head('Sessões aninhadas', nested.length ? `${usd(nestedUsd)} · ${kTok(nestedTokens)}` : undefined)}
            {Note('Ficam à parte: não entram no custo desta até você mesclar.')}
            {nested.map(k => (
              <Box flexDirection="column">
                <Box justifyContent="space-between" alignItems="center" gap="sm">
                  <Box alignItems="center" gap="xs" flexShrink={1} flexGrow={1} minWidth={0}>
                    <Text size="caption" color={k.running ? 'warning' : 'subtle'}>
                      ●
                    </Text>
                    <Text size="footnote" wrap="truncate">
                      {k.title}
                    </Text>
                  </Box>
                  <Text size="footnote" dimColor>
                    {k.running ? 'rodando' : 'parada'}
                  </Text>
                </Box>
                <Box paddingLeft={2} justifyContent="space-between" gap="sm" flexWrap="wrap">
                  {Note(
                    k.figures
                      ? join(
                          priceOf(k.figures.model || k.model || '')?.label ?? (k.model || undefined),
                          effortLabel(k.effort ?? k.figures.effort),
                          `${kTok(k.figures.tokens)} tokens`,
                          usd(k.figures.usd),
                        )
                      : 'Sem números ainda: aparecem depois da primeira resposta dela.',
                  )}
                  {k.figures && (k.figures.added > 0 || k.figures.removed > 0) && Diff(k.figures.added, k.figures.removed)}
                </Box>
              </Box>
            ))}
            {mergedList.map(m => Row(`✓ ${m.title}`, `${usd(m.usd)} · ${kTok(m.tokens)}`))}
          </Box>
        )}

        {Divider()}

        <Box flexDirection="column" gap="xs">
          {Head('Custo desta sessão')}
          {Row('Total', `${usd(totalUsd + mergedUsd)} · ${kTok(mainTokens + subsTokens + gemTokens + mergedTokens)}`, true)}
          {Row('Principal', `${mainLedger === undefined && mainEst.unpriced.length ? 'sem preço' : usd(mainUsd)} · ${kTok(mainTokens)}`)}
          {Row('Subagentes', `${usd(subsUsd)} · ${kTok(subsTokens)}`)}
          {devs.length > 0 && Row('Gemini', `${unpriced.length ? 'sem preço' : usd(gemUsd)} · ${kTok(gemTokens)}`)}
          {mergedList.length > 0 && Row('Mescladas', `${usd(mergedUsd)} · ${kTok(mergedTokens)}`)}
        </Box>


        {Divider()}

        <Box flexDirection="column" gap="xs">
          {Head('Longe do computador', away ? 'ligado' : undefined, away ? 'success' : undefined)}
          <Box justifyContent="space-between" alignItems="center" gap="sm">
            <Box flexShrink={1} minWidth={0}>
              {Note('Controle remoto e computador acordado enquanto a sessão trabalha')}
            </Box>
            <Box flexShrink={0}>
              <Button
                key="away"
                label={away ? 'Desligar' : 'Ligar'}
                variant={away ? 'secondary' : 'primary'}
                onPress={() =>
                  void (async () => {
                    const turnOn = !away
                    await update($, awayState, () => turnOn)
                    $.ui.toast(turnOn ? 'Pedindo pra sessão ligar o controle remoto e manter o computador acordado…' : 'Pedindo pra sessão desligar o controle remoto…')
                    await $.prompt.submit({ text: awayPrompt(turnOn), asUser: true })
                  })().catch(() => {})
                }
              />
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}
