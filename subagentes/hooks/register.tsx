import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Kid, Launch, Merged, Run, Tokens } from '../types'
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


type Item = { kind: 'dev' | 'sub'; run: Run; state: GeminiState }

/** O subagente de Claude que só despacha o Gemini já é a tarefa do Gemini: não vira card à parte. */
export const isWrapper = (r: Run) => r.type === 'gemini-dev' || /^(run )?gemini\b/i.test(r.description)

let ticker: Timer | undefined

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
        const all = await read($, runs)
        const subs = Object.values(all).some(r => !r.external && r.id !== MAIN && r.endedAt === undefined)
        const live = subs || kidsLive() || (await allGemini($, now, await read($, launches))).some(g => g.state === 'running')
        await foldMerged($)
        if (!live) {
          ticker?.cancel()
          ticker = undefined
          return
        }
        await update($, runs, a => ({ ...a }))
      } catch {}
    })()
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'subagentes', description: 'Abre o painel de subagentes e das tarefas do Gemini' })
    void $.ui.open({ id: PANE, title: 'Tarefas e subagentes' })
    startTicker($)
    void pruneStore($).catch(() => {})
    void publishOwn($, true)
    return next(e)
  })

  on('command.run', { command: 'subagentes' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tarefas e subagentes' })
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
    const out = await next(e)
    if (isGemini)
      try {
        const end = await $.clock.now()
        await update($, launches, all => all.map(l => (l.at === at ? { ...l, end } : l)))
        startTicker($)
      } catch {}
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

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    const id = e.agentId
    if (id) {
      const now = await $.clock.now()
      await update($, runs, all => (all[id] ? { ...all, [id]: { ...all[id], endedAt: now } } : all))
    } else {
      void publishOwn($, true)
      void foldMerged($)
    }
    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
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
        const status = live.get(r.id)?.status ?? (r.endedAt ? 'completed' : 'running')
        const state: GeminiState = status === 'completed' ? 'completed' : status === 'failed' || status === 'killed' ? 'failed' : 'running'
        return { kind: 'sub', run: r, state }
      })
    const items = [...devs, ...subs]

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

    const color = (s: GeminiState) => (s === 'running' ? 'yellow' : s === 'completed' ? 'green' : 'red')
    const label = (s: GeminiState) => (s === 'running' ? 'rodando' : s === 'completed' ? 'pronta' : s === 'failed' ? 'falhou' : 'sem sinal')


    /** "8,4 mi tokens · US$ 6,37 · +1.155 −252", a mesma linha na principal e nos subagentes. */
    const Stats = (p: { tokens: string; money: string; added: number; removed: number }) => (
      <Box flexWrap="wrap">
        <Text size="footnote">{`${p.tokens} · ${p.money} · `}</Text>
        <Text size="footnote" color="green">{`+${thousands(p.added)}`}</Text>
        <Text size="footnote"> </Text>
        <Text size="footnote" color="red">{`−${thousands(p.removed)}`}</Text>
      </Box>
    )

    const Card = (p: { g: Item }) => {
      const { run, state, kind } = p.g
      const c = costOf(run)
      const elapsed = dur((run.endedAt ?? now) - run.startedAt)
      const tokens = totalTokens(run)
      const money = c.unpriced.length ? 'sem preço' : tokens > 0 ? usd(c.usd) : 'US$ —'
      const badge =
        kind === 'dev'
          ? join(run.model || 'Gemini', effortLabel(run.effort), 'desenvolvendo')
          : join(priceOf(run.model)?.label ?? (run.model || 'Claude'), effortLabel(run.effort), /revis/i.test(run.description) ? 'revisando' : 'subagente')
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color(state)} paddingX="xs" paddingY="xs" marginTop="xs">
          <Text size="footnote" bold>
            <Text size="footnote" color={color(state)}>● </Text>
            {run.description || run.id}
          </Text>
          {run.title && run.title !== run.description && <Text size="footnote" bold>{run.title}</Text>}
          <Box flexWrap="wrap">
            <Text size="footnote" color={color(state)}>{`${state === 'running' ? elapsed : `${label(state)} · ${elapsed}`} · `}</Text>
            <Text size="footnote" color={kind === 'dev' ? 'cyan' : 'magenta'}>{badge}</Text>
          </Box>
          {Stats({
            tokens: tokens > 0 ? `${kTok(tokens)} tokens` : kind === 'dev' && state === 'running' ? 'tokens no fim' : '— tokens',
            money,
            added: run.added,
            removed: run.removed,
          })}
          {state === 'stale' && <Text size="footnote" color="red">Sem sinal há mais de 5 min. Pode ter sido interrompida.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" flexWrap="wrap">
          <Text size="footnote" bold>Tarefas e subagentes</Text>
          <Text size="footnote" color="green">{running.length > 0 ? '● ao vivo' : '○ parado'}</Text>
        </Box>

        <Box flexDirection="column" marginTop="xs">
          <Text size="caption" bold dimColor>
            LIMITES DO CLAUDE · conta toda
          </Text>
          {limits.length === 0 && <Text size="caption" dimColor>Sem leitura ainda: aparece depois da próxima resposta do modelo.</Text>}
          {limits.map(l => (
            <Box flexDirection="column" marginTop="xs">
              <Box justifyContent="space-between" flexWrap="wrap">
                <Text size="footnote">{limitLabel(l.kind)}</Text>
                <Text size="footnote" bold color={barColor(l.percentUsed)}>{`${String(l.percentUsed).replace('.', ',')}%`}</Text>
              </Box>
              <Text size="footnote" color={barColor(l.percentUsed)}>{bar(l.percentUsed, BAR_WIDTH)}</Text>
              {l.resetsAt && <Text size="caption" dimColor>{resetText(l.resetsAt, now)}</Text>}
            </Box>
          ))}
        </Box>

        <Text size="caption" dimColor>{'─'.repeat(BAR_WIDTH)}</Text>

        <Text size="caption" bold dimColor>
          ESTA SESSÃO
        </Text>
        <Box gap="xs" flexWrap="wrap" marginTop="xs">
          {[
            { money: usd(totalUsd + mergedUsd), tokens: mainTokens + subsTokens + gemTokens + mergedTokens, text: 'Total' },
            { money: usd(mainUsd), tokens: mainTokens, text: 'Principal' },
            { money: usd(subsUsd), tokens: subsTokens, text: 'Subagentes' },
            ...(mergedList.length ? [{ money: usd(mergedUsd), tokens: mergedTokens, text: 'Mescladas' }] : []),
          ].map(k => (
            <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="white" paddingX="xs" paddingY="xs">
              <Text size="caption" dimColor>
                {k.text}
              </Text>
              <Text size="footnote" bold>
                {k.money}
              </Text>
              <Text size="footnote">{`${kTok(k.tokens)} tokens`}</Text>
            </Box>
          ))}
        </Box>

        {(() => {
          const tokens = totalTokens(main)
          const label = priceOf(main.model || Object.keys(main.byModel)[0] || '')?.label ?? (main.model || 'Claude')
          return (
            <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX="xs" paddingY="xs" marginTop="xs">
              <Text size="footnote" bold>
                <Text size="footnote" color="blue">● </Text>
                Sessão principal
              </Text>
              <Text size="footnote" color="blue">{join(dur(now - usage.startedAt), label, effortLabel(mainEffort), 'coordenando')}</Text>
              {Stats({
                tokens: tokens > 0 ? `${kTok(tokens)} tokens` : '— tokens',
                money: mainLedger === undefined && mainEst.unpriced.length ? 'sem preço' : usd(mainUsd),
                added: diff.added,
                removed: diff.removed,
              })}
            </Box>
          )
        })()}

        <Box flexDirection="column" marginTop="xs" marginLeft="sm">
          <Text size="footnote" bold color="magenta">
            {`↳ Subagentes e tarefas desta sessão${devs.length > 0 ? ` · Gemini ${unpriced.length ? `${kTok(gemTokens)} tokens, sem preço` : usd(gemUsd)}` : ''}`}
          </Text>
          {items.length === 0 && <Text size="caption" dimColor>Nenhum subagente nem tarefa do Gemini ainda.</Text>}

          {running.length > 0 && (
            <Box flexDirection="column" marginTop="xs">
              <Text size="caption" bold dimColor>
                RODANDO
              </Text>
              {running.map(g => Card({ g }))}
            </Box>
          )}

          {finished.length > 0 && (
            <Box flexDirection="column" marginTop="xs">
              <Text size="caption" bold dimColor>
                TERMINADAS
              </Text>
              {finished.slice(0, DONE_SHOWN).map(g => Card({ g }))}
              {finished.length > DONE_SHOWN && <Text size="caption" dimColor>{`e mais ${finished.length - DONE_SHOWN} anteriores`}</Text>}
            </Box>
          )}
        </Box>

        {(nested.length > 0 || mergedList.length > 0) && (
          <Box flexDirection="column" marginTop="xs" marginLeft="sm">
            <Text size="footnote" bold color="blue">
              {`↳ Sessões aninhadas${nested.length ? ` · ${usd(nestedUsd)} · ${kTok(nestedTokens)} tokens` : ''}`}
            </Text>
            <Text size="caption" dimColor>Sessões à parte: não entram no total desta até você mesclar.</Text>
            {nested.map(k => (
              <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX="xs" paddingY="xs" marginTop="xs">
                <Text size="footnote" bold>
                  <Text size="footnote" color={k.running ? 'yellow' : 'gray'}>● </Text>
                  {k.title}
                </Text>
                <Text size="footnote" color="blue">
                  {join(
                    k.running ? 'rodando' : 'parada',
                    priceOf(k.figures?.model || k.model || '')?.label ?? (k.model || undefined),
                    effortLabel(k.effort ?? k.figures?.effort),
                  )}
                </Text>
                {k.figures ? (
                  Stats({
                    tokens: `${kTok(k.figures.tokens)} tokens`,
                    money: usd(k.figures.usd),
                    added: k.figures.added,
                    removed: k.figures.removed,
                  })
                ) : (
                  <Text size="caption" dimColor>Sem números ainda: aparecem depois da primeira resposta dela.</Text>
                )}
              </Box>
            ))}
            {mergedList.length > 0 && (
              <Box flexDirection="column" marginTop="xs">
                <Text size="caption" bold dimColor>
                  MESCLADAS AQUI · somadas ao total
                </Text>
                {mergedList.map(m => (
                  <Text size="caption" dimColor>{`✓ ${m.title} · ${usd(m.usd)} · ${kTok(m.tokens)} tokens`}</Text>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
