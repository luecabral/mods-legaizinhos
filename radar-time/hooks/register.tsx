import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderChildren } from 'claude-code'

import type {
  Alert,
  Config,
  Feed,
  IssueItem,
  Level,
  LinearProject,
  Member,
  PrItem,
  PrSize,
  PrStatus,
  ProjectProgress,
  Range,
  Team,
  TeamDef,
  View,
  Wizard,
} from '../types'

// A configuração fica no $.store (nunca no código): org do GitHub, workspace do Linear, times e termos extras.
const byName = (a: Member, b: Member) => a.name.localeCompare(b.name, 'pt-BR')
const emptyConfig = (): Config => ({ org: '', workspace: '', extraTerms: '', teams: [] })
let cfg: Config = emptyConfig()
const setCfg = (c: Config) => {
  cfg = c
}
const everyone = (): Member[] => [...new Map(cfg.teams.flatMap(t => t.members).map(m => [m.login, m])).values()].sort(byName)
// "Todos" aparece como mais uma opção de time quando há mais de um.
const choices = (): TeamDef[] => (cfg.teams.length > 1 ? [...cfg.teams, { id: 'todos', name: 'Todos', members: everyone() }] : cfg.teams)
const teamById = (id?: string): TeamDef | undefined => {
  const t = choices().find(x => x.id === id)
  return t && { ...t, members: [...t.members].sort(byName) }
}
const linearUrl = (id: string) => `https://linear.app/${cfg.workspace ? `${cfg.workspace}/` : ''}issue/${id}`
const FETCH_DAYS = 31
const SIZE_DAYS = 15 // mede tamanho e complexidade dos PRs abertos e dos que foram pro ar nesse intervalo
const STALE_DAYS = 14
const RECENT_DAYS = 21
const POLL_MS = 10 * 60 * 1000
const PROGRESS_TTL = 30 * 60 * 1000
const PANE = 'radar-time'
const TITLE = 'Radar do time'
const DAY = 86_400_000
const BAR_WIDTH = 18

// As ferramentas do Linear têm um prefixo que muda de conta para conta; descobertas em tempo de execução.
type LinearTools = { listIssues: string; getIssue: string; getProject: string }
let linearTools: LinearTools | undefined

async function findLinear($: Engine): Promise<LinearTools | undefined> {
  const names = (await $.tool.list()).filter(t => t.mcp).map(t => t.name)
  for (const n of names) {
    if (!n.endsWith('__list_issues')) continue
    const prefix = n.slice(0, -'list_issues'.length)
    if (names.includes(`${prefix}get_issue`) && names.includes(`${prefix}get_project`)) {
      return { listIssues: n, getIssue: `${prefix}get_issue`, getProject: `${prefix}get_project` }
    }
  }
  return undefined
}

const RANGES: { id: Range; label: string }[] = [
  { id: 'semana', label: 'Esta semana' },
  { id: 'passada', label: 'Semana passada' },
]

const feed = atom(
  { plugin: 'radar-time', key: 'feed' } as const,
  { items: [], issues: [], progress: {}, isLoading: false },
  { shape: 'feed-5' },
)
// Time escolhido por esta pessoa (guardado em $.store, que é da máquina dela).
const team = atom({ plugin: 'radar-time', key: 'team' } as const, { isReady: false, isChoosing: false } as Team, {
  shape: 'team-1',
})

// Configuração (org, Linear, times, termos): vem do $.store ao abrir a sessão.
const config = atom({ plugin: 'radar-time', key: 'config' } as const, { ...emptyConfig(), isReady: false }, {
  shape: 'config-1',
})
const emptyWizard = (c: Config): Wizard => ({
  isReady: true,
  isOpen: false,
  step: 'org',
  org: c.org,
  workspace: c.workspace ?? '',
  extraTerms: c.extraTerms ?? '',
  teams: c.teams,
  available: [],
  filter: '',
  isLoading: false,
  draftName: '',
  picked: {},
})
const wizard = atom({ plugin: 'radar-time', key: 'wizard' } as const, { ...emptyWizard(emptyConfig()), isReady: false }, {
  shape: 'wizard-1',
})

// PRs novos esperando um clique, no topo do painel. O toast do app não aceita clique, então o
// link fica aqui até a pessoa abrir ou dispensar.
const alerts = atom({ plugin: 'radar-time', key: 'alerts' } as const, [] as Alert[], { shape: 'alerts-1' })
const ALERT_LIMIT = 5

// Põe os avisos novos no topo, sem repetir PR, e guarda só os ALERT_LIMIT mais recentes.
export const pushAlerts = (list: Alert[], fresh: Alert[]): Alert[] => {
  const keys = new Set(fresh.map(a => a.key))
  return [...fresh, ...list.filter(a => !keys.has(a.key))].slice(0, ALERT_LIMIT)
}

// Abre o PR no Chrome; se o Chrome não abrir, cai no navegador padrão.
const openInChrome = async ($: Engine, url: string) => {
  const r = await $.process.run(['/usr/bin/open', '-a', 'Google Chrome', url], { timeoutMs: 10_000 }).catch(() => undefined)
  if (r?.exitCode !== 0) await $.process.run(['/usr/bin/open', url], { timeoutMs: 10_000 }).catch(() => undefined)
}

const view = atom({ plugin: 'radar-time', key: 'view' } as const, { range: 'semana', collapsed: [] }, {
  shape: 'view-2',
})

type GhPr = {
  repository: { name: string; nameWithOwner: string }
  number: number
  title: string
  state: string
  isDraft: boolean
  createdAt: string
  closedAt: string
  url: string
  body: string
}

type GhFile = { path: string; additions: number; deletions: number }

const TICKET = /\b([A-Z]{2,4}-\d{2,5})\b/
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

// Áreas sensíveis, reconhecidas pelo caminho dos arquivos. Termos genéricos; a pessoa pode acrescentar os do negócio dela.
const BASE_AREAS: { name: string; test: RegExp }[] = [
  { name: 'banco de dados', test: /(^|\/)db\/(migrate|schema\.rb|migrations)|migrations?\/|schema\.(sql|prisma)/i },
  { name: 'pagamentos', test: /payment|invoice|billing|wallet|refund|charge|subscription|withdraw|checkout|stripe/i },
  { name: 'login e segurança', test: /auth|session|password|login|permission|token|security|two_factor|oauth|secret|crypto/i },
  { name: 'integrações', test: /webhook|integration|connector|oauth|third_party|api_client|sdk/i },
  { name: 'infra', test: /^config\/|^\.github\/|Dockerfile|docker-compose|Gemfile|package\.json|Procfile|^bin\/|terraform|\.ya?ml$/i },
]
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Termos extras da configuração (separados por vírgula) viram mais uma área.
const areasOf = (c: Config): { name: string; test: RegExp }[] => {
  const terms = (c.extraTerms ?? '').split(',').map(t => t.trim()).filter(Boolean)
  return terms.length ? [...BASE_AREAS, { name: 'termos do negócio', test: new RegExp(terms.map(escapeRe).join('|'), 'i') }] : BASE_AREAS
}
const IS_TEST = /(^|\/)(spec|test)\/|_spec\.rb$|\.test\.[jt]sx?$/

function statusOf(pr: GhPr): PrStatus {
  if (pr.state === 'merged') return 'no ar'
  if (pr.state === 'closed') return 'fechado'
  return pr.isDraft ? 'rascunho' : 'em revisão'
}

// Datas no fuso do computador de quem usa.
function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function day(iso: string): string {
  const d = new Date(Date.parse(iso))
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function num(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

type Window = { range: Range; start: string; end: string }

// Esta semana: de segunda 00:00 (no fuso do computador) até agora. Semana passada: a segunda anterior até essa.
function windowOf(range: Range, now: number): Window {
  const d = new Date(now)
  const sinceMonday = (d.getDay() + 6) % 7
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime()
  if (range === 'passada') {
    return { range, start: new Date(monday - 7 * DAY).toISOString(), end: new Date(monday).toISOString() }
  }
  return { range, start: new Date(monday).toISOString(), end: '9999' }
}

function isOpen(i: PrItem): boolean {
  return i.status === 'em revisão' || i.status === 'rascunho'
}

// Entra no período o que foi aberto ou foi pro ar dentro dele.
// Esta semana também mostra tudo que segue aberto, mesmo que tenha sido aberto antes.
function inRange(i: PrItem, w: Window): boolean {
  if (i.status === 'fechado') return false
  if (w.range === 'semana' && isOpen(i)) return true
  const within = (iso?: string) => !!iso && iso >= w.start && iso < w.end
  return within(i.createdAt) || within(i.closedAt)
}

function shippedIn(i: PrItem, w: Window): boolean {
  return i.status === 'no ar' && !!i.closedAt && i.closedAt >= w.start && i.closedAt < w.end
}

// O processo do app pode subir sem HOME nem PATH (o app aberto pelo Dock não lê o perfil do shell).
// Sem HOME o gh não acha ~/bin/gh nem o login em ~/.config/gh e diz "not logged in".
// `~` o sh resolve pela conta do usuário mesmo sem HOME, então a busca devolve a home e o caminho do gh.
const GH_LOOKUP =
  'h=~; echo "$h"; for p in "$(command -v gh)" "$h/bin/gh" /opt/homebrew/bin/gh /usr/local/bin/gh; do [ -x "$p" ] && { echo "$p"; exit 0; }; done; exit 1'
const BASE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
type GhSetup = { bin: string; env: Record<string, string> }
let ghSetup: GhSetup | null = null

async function ghEnvFor($: Engine, home: string): Promise<Record<string, string>> {
  const path = (await $.env.get('PATH')) || BASE_PATH
  return { HOME: (await $.env.get('HOME')) || home, PATH: `${home}/bin:${path}` }
}

async function ghResolve($: Engine): Promise<GhSetup> {
  if (ghSetup) return ghSetup
  try {
    const run = await $.process.run(['/bin/sh', '-c', GH_LOOKUP], { timeoutMs: 10_000 })
    const [home = '', found = ''] = run.stdout.trim().split('\n').map(s => s.trim())
    const env = await ghEnvFor($, home)
    if (run.exitCode === 0 && found) {
      ghSetup = { bin: found, env }
      return ghSetup
    }
    return { bin: 'gh', env }
  } catch {
    return { bin: 'gh', env: {} }
  }
}

async function ghRun($: Engine, args: string[], timeoutMs: number) {
  const { bin, env } = await ghResolve($)
  return $.process.run([bin, ...args], { timeoutMs, env })
}

// Erro de rede que passa sozinho (conexão cortada pelo GitHub, 502, limite secundário): vale tentar de novo.
const TRANSIENT = /EOF|timeout|timed out|connection reset|connection refused|502|503|504|secondary rate limit|abuse|i\/o/i

async function gh($: Engine, args: string[]): Promise<string> {
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await $.clock.sleep(1500 * attempt)
    const run = await ghRun($, args, 60_000)
    if (run.exitCode === 0) return run.stdout
    last = run.stderr.trim() || `gh saiu com ${run.exitCode}`
    if (!TRANSIENT.test(last)) break
  }
  throw new Error(last)
}

async function fetchDev($: Engine, login: string, since: string): Promise<GhPr[]> {
  const out = await gh($, [
    'search', 'prs',
    '--author', login,
    '--owner', cfg.org,
    '--created', `>=${since}`,
    '--sort', 'created',
    '--limit', '100',
    '--json', 'repository,number,title,state,isDraft,createdAt,closedAt,url,body',
  ])
  return JSON.parse(out) as GhPr[]
}

// Lê o JSON de uma resposta do modelo ({...} em qualquer lugar do texto).
function jsonOf(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// Resume vários PRs numa chamada só ao Haiku (bem mais rápido que um por um).
async function translateMany($: Engine, prs: GhPr[]): Promise<(string | undefined)[]> {
  const r = await $.model.complete({
    model: 'haiku',
    system:
      'Você resume pull requests de uma empresa de software para uma pessoa de produto que não é técnica. ' +
      'Para CADA PR, escreva UMA frase em português do Brasil, de no máximo 14 palavras, começando direto pelo verbo no passado ou presente ' +
      '(ex.: "Carrinho não esvazia mais quando o comprador entra na conta", "Corrige o menu escondido no celular"). ' +
      'Não cite o nome de quem fez. Diga o que muda para o lojista ou para o comprador, sem jargão ' +
      '(nada de spec, CI, refactor, payload, HMAC, endpoint, merge). Se for trabalho interno de engenharia, diga em poucas palavras para que serve. ' +
      'Sem aspas internas, sem markdown, sem ponto final. ' +
      'Responda SÓ com JSON, uma chave por PR com o número dele: {"1":"...","2":"..."}.',
    prompt: prs
      .map((pr, n) => `### ${n + 1}\nTítulo: ${pr.title}\nDescrição:\n${(pr.body ?? '').slice(0, 700)}`)
      .join('\n\n'),
    maxTokens: 60 * prs.length + 50,
  })
  if (!r.isAnswered) return []
  const json = jsonOf(r.text)
  return prs.map((_, n) => {
    const t = json[String(n + 1)]
    return typeof t === 'string' && t.trim() ? t.trim().replace(/^["“]|["”.]$/g, '') : undefined
  })
}

// Linhas, arquivos e áreas do PR, direto do GitHub.
async function measure($: Engine, pr: GhPr): Promise<{ size: PrSize; files: GhFile[] }> {
  const out = await gh($, [
    'pr', 'view', String(pr.number),
    '-R', pr.repository.nameWithOwner,
    '--json', 'additions,deletions,changedFiles,files',
  ])
  const data = JSON.parse(out) as { additions: number; deletions: number; changedFiles: number; files: GhFile[] }
  const files = data.files ?? []
  const testLines = files.filter(f => IS_TEST.test(f.path)).reduce((s, f) => s + f.additions + f.deletions, 0)
  const areas = areasOf(cfg).filter(a => files.some(f => !IS_TEST.test(f.path) && a.test.test(f.path))).map(a => a.name)

  return {
    size: { additions: data.additions, deletions: data.deletions, files: data.changedFiles, testLines, areas },
    files,
  }
}

const LEVELS: Level[] = ['baixa', 'média', 'alta']
function asLevel(x: unknown): Level | undefined {
  const s = String(x ?? '').toLowerCase().replace('media', 'média')
  return LEVELS.find(l => l === s)
}

type Assessment = Pick<PrSize, 'complexity' | 'care' | 'why'>

// Complexidade (quanto trabalho e raciocínio) e cuidado (o estrago se der errado), lidos pelo Haiku em lote.
async function assessMany($: Engine, list: { pr: GhPr; size: PrSize; files: GhFile[] }[]): Promise<Assessment[]> {
  const r = await $.model.complete({
    model: 'haiku',
    system:
      'Você avalia pull requests de uma empresa de software para uma pessoa de produto. ' +
      'Para CADA PR, dê duas notas, cada uma "baixa", "média" ou "alta":\n' +
      '- complexidade: quanto trabalho e raciocínio o PR exigiu. Linhas de teste e arquivos gerados pesam pouco; ' +
      'lógica nova, várias partes do sistema conectadas e regras de negócio difíceis pesam muito. Muitas linhas simples não são complexidade alta.\n' +
      '- cuidado: o estrago se der errado em produção. Alto quando mexe em dinheiro, pagamento, login e segurança, dados dos clientes, ' +
      'migração de banco, integrações externas ou algo que afeta todas as lojas. Baixo para texto, visual isolado, testes e docs.\n' +
      'Responda SÓ com JSON, uma chave por PR com o número dele: ' +
      '{"1":{"complexidade":"...","cuidado":"...","motivo":"..."},"2":{...}}, ' +
      'onde motivo tem no máximo 12 palavras em português simples, sem jargão, explicando o principal fator.',
    prompt: list
      .map(({ pr, size, files }, n) =>
        `### ${n + 1}\nTítulo: ${pr.title}\n` +
        `Tamanho: +${size.additions} -${size.deletions} linhas, ${size.files} arquivos, ${size.testLines} linhas em testes\n` +
        `Áreas sensíveis tocadas: ${size.areas.join(', ') || 'nenhuma'}\n` +
        `Arquivos:\n${files.slice(0, 25).map(f => `${f.path} +${f.additions} -${f.deletions}`).join('\n')}\n` +
        `Descrição:\n${(pr.body ?? '').slice(0, 500)}`,
      )
      .join('\n\n'),
    maxTokens: 90 * list.length + 50,
  })
  if (!r.isAnswered) return []
  const json = jsonOf(r.text)
  return list.map((_, n) => {
    const x = json[String(n + 1)]
    if (!x || typeof x !== 'object') return {}
    const o = x as Record<string, unknown>
    return {
      complexity: asLevel(o.complexidade),
      care: asLevel(o.cuidado),
      why: typeof o.motivo === 'string' ? o.motivo.trim().replace(/\.$/, '') : undefined,
    }
  })
}

// Lê um JSON devolvido por uma ferramenta do Linear; undefined se a chamada falhou.
// Chama o servidor direto ($.mcp.call), que não depende de a pessoa ter liberado as ferramentas
// do Linear nas permissões; se não der, tenta como chamada de ferramenta comum.
async function linearCall($: Engine, tool: string | undefined, input: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  if (!tool) return undefined
  const cut = tool.lastIndexOf('__')
  try {
    const r = await $.mcp.call(tool.slice('mcp__'.length, cut), tool.slice(cut + 2), input)
    const text = r.content.map(c => (c.type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join('')
    if (!r.isError && text) return JSON.parse(text) as Record<string, unknown>
  } catch {
    // segue para a chamada comum
  }
  try {
    const r = await $.tool.call({ tool, ...input } as Parameters<Engine['tool']['call']>[0])
    if ('deny' in r && r.deny) return undefined
    const text = (r as { text?: string }).text
    if (!text) return undefined
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

type LinearCache = {
  issues: Record<string, string | null>
  projects: Record<string, LinearProject>
}

async function projectByName($: Engine, name: string, cache: LinearCache): Promise<LinearProject | undefined> {
  if (!cache.projects[name]) {
    const project = await linearCall($, linearTools?.getProject, { query: name })
    if (!project || typeof project.url !== 'string') return undefined
    cache.projects[name] = { name, url: project.url }
  }

  return cache.projects[name]
}

// Ticket -> projeto do Linear (nome e link). Guardado entre sessões; null quando a issue não tem projeto.
async function projectOfTicket($: Engine, ticket: string, cache: LinearCache): Promise<LinearProject | undefined> {
  let name = cache.issues[ticket]
  if (name === undefined) {
    const issue = await linearCall($, linearTools?.getIssue, { id: ticket, fields: ['project'] })
    if (!issue) return undefined
    name = typeof issue.project === 'string' && issue.project ? issue.project : null
    cache.issues[ticket] = name
  }

  return name ? projectByName($, name, cache) : undefined
}

// Cards do Linear em andamento de um dev.
async function fetchIssues($: Engine, dev: { name: string; linear: string }, cache: LinearCache): Promise<IssueItem[] | undefined> {
  const r = await linearCall($, linearTools?.listIssues, {
    assignee: dev.linear,
    state: 'started',
    fields: ['id', 'title', 'url', 'status', 'project', 'startedAt', 'updatedAt'],
    limit: 50,
  })
  if (!r || !Array.isArray(r.issues)) return undefined
  const raw = r.issues as Record<string, unknown>[]

  return Promise.all(
    raw.map(async (i): Promise<IssueItem> => {
      const id = String(i.id)
      const projectName = typeof i.project === 'string' && i.project ? i.project : undefined
      cache.issues[id] = projectName ?? null
      return {
        id,
        dev: dev.name,
        title: String(i.title ?? id),
        url: typeof i.url === 'string' ? i.url : linearUrl(id),
        status: String(i.status ?? 'em andamento'),
        startedAt: typeof i.startedAt === 'string' ? i.startedAt : undefined,
        updatedAt: typeof i.updatedAt === 'string' ? i.updatedAt : undefined,
        projectName,
        project: projectName ? await projectByName($, projectName, cache) : undefined,
      }
    }),
  )
}

// Progresso de um projeto: quantos cards estão feitos, em andamento e no total (sem cancelados).
async function fetchProgress($: Engine, name: string): Promise<ProjectProgress | undefined> {
  const counts = { done: 0, doing: 0, total: 0 }
  let cursor: string | undefined
  for (let page = 0; page < 4; page++) {
    const r = await linearCall($, linearTools?.listIssues, {
      project: name,
      fields: ['id', 'statusType'],
      limit: 250,
      ...(cursor ? { cursor } : {}),
    })
    if (!r || !Array.isArray(r.issues)) return page === 0 ? undefined : counts
    for (const i of r.issues as Record<string, unknown>[]) {
      const type = String(i.statusType ?? '')
      if (type === 'canceled' || type === 'duplicate') continue
      counts.total++
      if (type === 'completed') counts.done++
      else if (type === 'started') counts.doing++
    }
    if (!r.hasNextPage || typeof r.cursor !== 'string') break
    cursor = r.cursor
  }

  return counts
}

// O app descarta um painel cuja árvore passa de 100 mil caracteres, então o painel não tem fotos
// e cada grupo mostra até GROUP_LIMIT itens antes do "ver mais".
const GROUP_LIMIT = 8

// Roda `work` em cada item, no máximo `limit` de cada vez.
async function pool<T>(list: T[], limit: number, work: (x: T) => Promise<void>) {
  let next = 0
  const lane = async () => {
    while (next < list.length) {
      const x = list[next++] as T
      await work(x).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane))
}

let isRefreshing = false
let isPending = false // pediram outra busca enquanto uma rodava (ex.: trocou de time)
// Pedido de busca vindo de um clique ou do /tech. Quem busca é o relógio da sessão (session.start):
// o $ de um clique deixa de valer quando o clique termina, e o resultado não chegaria ao painel.
let isRequested = false
let isManualRequest = false
function requestRefresh(opts: { isManual?: boolean } = {}) {
  isRequested = true
  if (opts.isManual) isManualRequest = true
}
const TICK_MS = 2000

// O gh precisa estar instalado e logado.
async function hasGh($: Engine): Promise<{ isOk: boolean; detail?: string }> {
  let detail = ''
  try {
    // O chaveiro do macOS às vezes falha na primeira leitura; uma segunda tentativa resolve.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await $.clock.sleep(1000)
      const run = await ghRun($, ['auth', 'status'], 20_000)
      if (run.exitCode === 0) return { isOk: true }
      detail = (run.stderr.trim() || run.stdout.trim() || `saiu com ${run.exitCode}`).split('\n').slice(0, 3).join(' · ')
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }
  const setup = await ghResolve($).catch(() => undefined)
  return { isOk: false, detail: `${detail} [gh: ${setup?.bin ?? '?'}, HOME: ${setup?.env.HOME || 'vazio'}]` }
}

async function refresh($: Engine, opts: { isManual?: boolean } = {}) {
  if (isRefreshing) {
    isPending = true
    return
  }
  isPending = false
  const current = await read($, team)
  const def = teamById(current.id)
  if (!def || !cfg.org) return // sem time escolhido: não busca nem avisa
  // Busca só o time escolhido, pra não pedir ao GitHub a lista de todo mundo de uma vez;
  // trocar de time dispara uma busca nova (ver pick).
  const members = def.members
  isRefreshing = true
  await update($, feed, f => ({ ...f, isLoading: true, error: undefined }))
  try {
    const ghCheck = await hasGh($)
    if (!ghCheck.isOk) {
      await update($, feed, f => ({ ...f, isLoading: false, loading: undefined, isGhMissing: true, ghDetail: ghCheck.detail }))
      return
    }
    // Linear só entra se a pessoa configurou o workspace; sem ele o radar usa só o GitHub.
    linearTools = cfg.workspace ? await findLinear($) : undefined
    await update($, feed, f => ({ ...f, isGhMissing: undefined, ghDetail: undefined }))
    const now = await $.clock.now()
    const since = new Date(now - FETCH_DAYS * DAY).toISOString().slice(0, 10)
    const sizeSince = new Date(now - SIZE_DAYS * DAY).toISOString()
    const cache = ((await $.store.get('traducoes-2')) ?? {}) as Record<string, string>
    const sizes = ((await $.store.get('tamanhos-1')) ?? {}) as Record<string, PrSize>
    const linear: LinearCache = {
      issues: ((await $.store.get('linear-issues')) ?? {}) as Record<string, string | null>,
      projects: ((await $.store.get('linear-projetos')) ?? {}) as Record<string, LinearProject>,
    }
    const seenKey = 'vistos-todos'
    const seen = (await $.store.get(seenKey)) as Record<string, PrStatus> | undefined
    const isFirstRun = seen === undefined
    const nextSeen: Record<string, PrStatus> = { ...(seen ?? {}) }

    const step = (label: string, done: number, total: number) =>
      update($, feed, f => ({ ...f, loading: { label, done, total } }))

    // Etapa 1: PRs de cada pessoa no GitHub e cards do Linear, ao mesmo tempo.
    let found = 0
    await step('Buscando PRs e cards', 0, members.length)
    // No máximo 4 buscas no GitHub ao mesmo tempo: as 13 juntas faziam o GitHub cortar a conexão (EOF).
    const perDevMap = new Map<string, { pr: GhPr; member: Member }[]>()
    const [, issueLists] = await Promise.all([
      pool(members, 4, async m => {
        const prs = await fetchDev($, m.login, since)
        perDevMap.set(m.login, prs.map(pr => ({ pr, member: m })))
        found++
        await step('Buscando PRs e cards', found, members.length)
      }),
      linearTools ? Promise.all(members.filter(m => m.linear).map(dev => fetchIssues($, dev, linear))) : Promise.resolve([]),
    ])
    const isLinearMissing = !!cfg.workspace && !linearTools
    const linearError = linearTools && issueLists.some(l => l === undefined)
      ? 'Não consegui ler o Linear agora; mostrando só os PRs.'
      : undefined
    const issues = issueLists.flatMap(l => l ?? [])

    // Já mostra a lista com o que estava guardado (tradução, tamanho, projeto); o resto chega aos poucos.
    const raw = members.flatMap(m => perDevMap.get(m.login) ?? [])
    const items: PrItem[] = raw
      .map(({ pr, member }): PrItem => {
        const key = `${pr.repository.nameWithOwner}#${pr.number}`
        const ticket = (pr.title.match(TICKET) ?? (pr.body ?? '').match(TICKET))?.[1]
        const projectName = ticket ? linear.issues[ticket] : undefined
        return {
          key,
          login: member.login,
          dev: member.name,
          repo: pr.repository.name,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          status: statusOf(pr),
          createdAt: pr.createdAt,
          closedAt: pr.closedAt?.startsWith('0001') ? undefined : pr.closedAt,
          ticket,
          ticketUrl: ticket ? linearUrl(ticket) : undefined,
          project: projectName ? linear.projects[projectName] : undefined,
          plain: cache[key],
          size: sizes[key],
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    await update($, feed, f => ({ ...f, items, issues, linearError, isLinearMissing }))

    // Etapa 2: resume, mede e acha o projeto só do que aparece no painel (aberto ou mexido desde a semana passada).
    // Resumos e notas vão ao Haiku em lotes; tudo roda ao mesmo tempo e cada lote já aparece no painel.
    const shownSince = windowOf('passada', now).start
    const prOf = new Map(raw.map(({ pr }) => [`${pr.repository.nameWithOwner}#${pr.number}`, pr]))
    const needsSize = (i: PrItem) =>
      (isOpen(i) || (i.status === 'no ar' && (i.closedAt ?? '') >= sizeSince)) && !(i.status === 'no ar' && i.size?.complexity)
    const todo = items.filter(
      i => prOf.has(i.key) && i.status !== 'fechado' && (isOpen(i) || i.createdAt >= shownSince || (i.closedAt ?? '') >= shownSince),
    )
    const needText = todo.filter(i => !i.plain)
    const needProject = todo.filter(i => i.ticket && !i.project)
    const needSize = todo.filter(needsSize)
    const label = 'Lendo e resumindo os PRs'
    const total = needText.length + needProject.length + needSize.length
    let done = 0
    const push = async (changed: PrItem[], n: number) => {
      done += n
      const snap = new Map(changed.map(i => [i.key, { ...i }]))
      await update($, feed, f => ({
        ...f,
        items: f.items.map(x => snap.get(x.key) ?? x),
        loading: { label, done, total },
      }))
    }
    await step(label, 0, total)
    await Promise.all([
      pool(chunks(needText, 12), 4, async batch => {
        const texts = await translateMany($, batch.map(i => prOf.get(i.key) as GhPr)).catch(() => [])
        batch.forEach((i, n) => {
          const t = texts[n]
          if (t) cache[i.key] = i.plain = t
        })
        await push(batch, batch.length)
      }),
      pool(needProject, 6, async i => {
        i.project = await projectOfTicket($, i.ticket as string, linear)
        await push([i], 1)
      }),
      (async () => {
        const toAssess: { item: PrItem; pr: GhPr; size: PrSize; files: GhFile[] }[] = []
        await pool(needSize, 8, async i => {
          const pr = prOf.get(i.key) as GhPr
          const measured = await measure($, pr).catch(() => undefined)
          if (!measured) return push([i], 1)
          const m = measured.size
          const old = i.size
          if (old?.complexity && old.additions === m.additions && old.deletions === m.deletions && old.files === m.files) {
            return push([i], 1)
          }
          i.size = m
          sizes[i.key] = m
          toAssess.push({ item: i, pr, size: m, files: measured.files })
        })
        await pool(chunks(toAssess, 6), 4, async batch => {
          const notes = await assessMany($, batch).catch(() => [])
          batch.forEach((b, n) => {
            b.item.size = { ...b.size, ...(notes[n] ?? {}) }
            sizes[b.item.key] = b.item.size
          })
          await push(batch.map(b => b.item), batch.length)
        })
      })(),
    ])

    // Progresso de cada projeto que aparece no painel. Guardado por 30 minutos: muda devagar e custa caro.
    const projectNames = new Set<string>()
    for (const i of issues) if (i.projectName) projectNames.add(i.projectName)
    for (const p of items) if (p.project) projectNames.add(p.project.name)
    const savedProgress = ((await $.store.get('progresso-1')) ?? {}) as Record<string, { at: number; p: ProjectProgress }>
    const progress: Record<string, ProjectProgress> = {}
    const stale: string[] = []
    for (const name of projectNames) {
      const hit = savedProgress[name]
      if (hit && now - hit.at < PROGRESS_TTL) progress[name] = hit.p
      else stale.push(name)
    }
    let counted = 0
    if (stale.length) await step('Contando o progresso dos projetos', 0, stale.length)
    await pool(stale, 6, async name => {
      const p = await fetchProgress($, name)
      if (p) {
        progress[name] = p
        savedProgress[name] = { at: now, p }
      }
      counted++
      await step('Contando o progresso dos projetos', counted, stale.length)
    })
    await $.store.set('progresso-1', savedProgress)

    // Avisos: PR novo e PR que foi pro ar. Na primeira vez só registra, sem avisar.
    // Só avisa do time escolhido agora (ou de todo mundo em "Todos").
    const watched = new Set((teamById((await read($, team)).id)?.members ?? []).map(m => m.login))
    const opened: Alert[] = []
    if (!isFirstRun) {
      for (const item of items.filter(i => watched.has(i.login))) {
        const before = seen[item.key]
        const what = item.plain ?? item.title
        if (before === undefined) {
          void $.ui.notify(what, { title: `${item.dev} abriu um PR` }).catch(() => undefined)
          $.ui.toast(`${item.dev} abriu: ${what} · abra pelo radar`, { timeoutMs: 8000 })
          opened.push({ key: item.key, dev: item.dev, what, url: item.url })
        } else if (before !== 'no ar' && item.status === 'no ar') {
          void $.ui.notify(what, { title: `Foi pro ar (${item.dev})` }).catch(() => undefined)
          $.ui.toast(`No ar (${item.dev}): ${what}`, { timeoutMs: 8000 })
        }
      }
    }
    if (opened.length) await update($, alerts, cur => pushAlerts(cur, opened))
    for (const item of items) nextSeen[item.key] = item.status

    await $.store.set('traducoes-2', cache)
    await $.store.set('tamanhos-1', sizes)
    await $.store.set('linear-issues', linear.issues)
    await $.store.set('linear-projetos', linear.projects)
    await $.store.set(seenKey, nextSeen)
    // Se o time mudou durante a busca, descarta o resultado.
    const result = { items, issues, progress, updatedAt: now, isLoading: false, linearError, isLinearMissing }
    await update($, feed, () => result)
    // Guarda a última busca: na próxima sessão o painel já abre com ela, enquanto busca de novo.
    await $.store.set('ultima-busca', result)
    if (opts.isManual) $.ui.toast('Radar atualizado')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, feed, f => ({ ...f, isLoading: false, loading: undefined, error: message, isGhMissing: undefined }))
  } finally {
    isRefreshing = false
    if (isPending) void refresh($)
  }
}

function dates(i: PrItem): string {
  if (i.status === 'no ar' && i.closedAt) return `foi pro ar ${day(i.closedAt)} · aberto ${day(i.createdAt)}`
  return `aberto ${day(i.createdAt)}`
}

function isStale(i: IssueItem, now: number): boolean {
  return !!i.updatedAt && Date.parse(i.updatedAt) < now - STALE_DAYS * DAY
}

// Card entra em "andamento" só se teve movimento nos últimos RECENT_DAYS dias:
// mudou no Linear, ou tem PR aberto ou que foi pro ar nesse intervalo.
function isRecent(i: IssueItem, prs: PrItem[], now: number): boolean {
  const since = new Date(now - RECENT_DAYS * DAY).toISOString()
  if ((i.updatedAt ?? '') >= since) return true
  return prs.some(pr => pr.ticket === i.id && (pr.createdAt >= since || (pr.closedAt ?? '') >= since))
}

function issueDates(i: IssueItem, now: number): string {
  const parts: string[] = []
  if (i.startedAt) parts.push(`desde ${day(i.startedAt)}`)
  if (isStale(i, now) && i.updatedAt) parts.push(`sem mexer desde ${day(i.updatedAt)}`)
  return parts.join(' · ')
}

function sizeLine(s: PrSize): string {
  const testPct = s.additions + s.deletions > 0 ? Math.round((s.testLines / (s.additions + s.deletions)) * 100) : 0
  return `+${num(s.additions)} −${num(s.deletions)} linhas · ${s.files} arquivos · ${testPct}% em testes`
}

// Datas curtas para a linha de status: "qua 04/11" ou "no ar sex 07/11".
function shortDates(i: PrItem): string {
  if (i.status === 'no ar' && i.closedAt) return day(i.closedAt)
  return `desde ${day(i.createdAt)}`
}

// Como o status aparece no painel: tudo que é revisão vira "review".
function statusLabel(status: string): string {
  return /revis/i.test(status) ? 'review' : status
}

function careLabel(l?: Level): string {
  return l === 'alta' ? 'alto' : l === 'média' ? 'médio' : l === 'baixa' ? 'baixo' : '?'
}

function levelColor(l?: Level): string {
  return l === 'alta' ? 'red' : l === 'média' ? 'yellow' : 'green'
}

function bar(done: number, total: number): string {
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

// Resumo das entregas de um dev num período: PRs no ar, linhas, arquivos, complexidade e cuidado.
function delivered(prs: PrItem[]) {
  const sized = prs.filter(p => p.size)
  const sum = (f: (s: PrSize) => number) => sized.reduce((acc, p) => acc + f(p.size as PrSize), 0)
  const count = (k: 'complexity' | 'care', l: Level) => sized.filter(p => p.size?.[k] === l).length
  return {
    count: prs.length,
    additions: sum(s => s.additions),
    deletions: sum(s => s.deletions),
    files: sum(s => s.files),
    tests: sum(s => s.testLines),
    complexity: LEVELS.map(l => [l, count('complexity', l)] as const),
    care: LEVELS.map(l => [l, count('care', l)] as const),
    risky: sized.filter(p => p.size?.care === 'alta'),
    unsized: prs.length - sized.length,
  }
}

function summary(members: Member[], f: Feed, range: Range, now: number): string {
  const w = windowOf(range, now)
  const label = RANGES.find(r => r.id === range)?.label.toLowerCase() ?? range
  return members.map(({ name: dev }) => {
    const doing = range === 'semana' ? f.issues.filter(i => i.dev === dev && isRecent(i, f.items, now)) : []
    const mine = f.items.filter(i => i.dev === dev && inRange(i, w))
    const shipped = mine.filter(p => shippedIn(p, w))
    const d = delivered(shipped)
    const open = mine.filter(isOpen)
    const lines = [
      ...doing.map(i => `  - [${i.status}, ${issueDates(i, now)}] ${i.title}`),
      ...mine.slice(0, 8).map(i => {
        const s = i.size
        const extra = s ? ` (${sizeLine(s)}; complexidade ${s.complexity ?? '?'}, cuidado ${s.care ?? '?'})` : ''
        return `  - [PR ${i.status} em ${i.repo}, ${dates(i)}] ${i.plain ?? i.title}${extra}`
      }),
    ]
    const head =
      `${dev} (${label}): ${range === 'semana' ? `${plural(doing.length, 'card', 'cards')} em andamento, ` : ''}` +
      `${plural(open.length, 'PR', 'PRs')} em review, ${d.count} no ar (+${num(d.additions)} −${num(d.deletions)} linhas, ${d.files} arquivos)`
    return `${head}${lines.length ? '\n' + lines.join('\n') : ''}`
  }).join('\n\n')
}

const slug = (t: string) =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'time'

// Guarda a configuração no $.store e passa a usar ela. Se o time escolhido saiu, pede escolha de novo.
async function saveConfig($: Engine, c: Config) {
  setCfg(c)
  await $.store.set('config-1', c)
  await update($, config, () => ({ ...c, isReady: true }))
  const current = (await read($, team)).id
  const onlyOne = c.teams.length === 1 ? c.teams[0]?.id : undefined
  const keep = teamById(current)?.id ?? onlyOne
  if (keep) await $.store.set('time', keep)
  else await $.store.delete('time')
  await update($, team, () => ({ id: keep, isReady: true, isChoosing: false }))
  // Outro time ou outra org: o que estava buscado não vale mais.
  await update($, feed, f => ({ ...f, items: [], issues: [], progress: {}, updatedAt: undefined, error: undefined }))
  await $.store.delete('ultima-busca')
  await $.store.delete('vistos-todos')
  requestRefresh()
}

// Org do GitHub que a pessoa digitou; só letras, números e hífen.
const isOrg = (t: string) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t)

// Lista os membros da org no GitHub (roda no relógio da sessão, porque o $ de um clique expira).
let membersRequest: string | undefined
async function loadMembers($: Engine, org: string) {
  try {
    const ghCheck = await hasGh($)
    if (!ghCheck.isOk) throw new Error('Instale e faça login no GitHub CLI (`gh auth login`).')
    const out = await gh($, ['api', `orgs/${org}/members`, '--paginate', '--jq', '.[].login'])
    const logins = out.split('\n').map(l => l.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
    await update($, wizard, w => ({
      ...w,
      isLoading: false,
      available: logins,
      error: logins.length ? undefined : 'O GitHub não devolveu membros dessa org. Você pode digitar os logins à mão.',
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, wizard, w => ({
      ...w,
      isLoading: false,
      error: `Não consegui listar os membros de ${org}: ${message}. Você pode digitar os logins à mão.`,
    }))
  }
}

// Escolhe (ou troca) o time: guarda e filtra. A busca já tem todo mundo; só busca se nunca carregou.
async function pick($: Engine, id: string) {
  const def = teamById(id)
  if (!def) return
  const before = (await read($, team)).id
  await $.store.set('time', id)
  await update($, team, () => ({ id, isReady: true, isChoosing: false }))
  const f = await read($, feed)
  // A busca só traz o time escolhido, então outro time precisa de uma busca nova.
  if (id !== before || !f.updatedAt) requestRefresh()
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'radar', description: 'Abre o Radar do time (o que o seu time está fazendo)' })
    const saved = (await $.store.get('periodo')) as Range | undefined
    if (saved && RANGES.some(r => r.id === saved)) await update($, view, v => ({ ...v, range: saved }))
    const saved0 = (await $.store.get('config-1')) as Config | undefined
    const c: Config = saved0 && typeof saved0.org === 'string' && Array.isArray(saved0.teams) ? saved0 : emptyConfig()
    setCfg(c)
    await update($, config, () => ({ ...c, isReady: true }))
    await update($, wizard, () => ({ ...emptyWizard(c), isOpen: !c.org || c.teams.length === 0 }))
    const id = (await $.store.get('time')) as string | undefined
    const def = teamById(id) ?? (c.teams.length === 1 ? teamById(c.teams[0]?.id) : undefined)
    await update($, team, () => ({ id: def?.id, isReady: true, isChoosing: false }))
    const last = (await $.store.get('ultima-busca')) as Feed | undefined
    if (last?.updatedAt && Array.isArray(last.items)) {
      await update($, feed, f => (f.updatedAt ? f : { ...last, isLoading: false, loading: undefined }))
    }
    // O painel só abre pelo /tech; a busca e os avisos rodam desde o começo da sessão, mas só depois de escolher o time.
    timer?.cancel()
    let elapsed = 0
    timer = $.clock.every(TICK_MS, () => {
      elapsed += TICK_MS
      if (membersRequest) {
        const org = membersRequest
        membersRequest = undefined
        void loadMembers($, org)
      }
      if (!isRequested && elapsed < POLL_MS) return
      const isManual = isManualRequest
      isRequested = false
      isManualRequest = false
      elapsed = 0
      void refresh($, { isManual })
    })
    void refresh($)

    return started
  })

  on('command.run', { command: 'radar' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const t = await read($, team)
    const def = teamById(t.id)
    const f = await read($, feed)
    if (def && !f.updatedAt) requestRefresh()
    // Com o painel aberto, o texto é só uma linha; a lista inteira em texto vai só quando o painel não abre,
    // junto do motivo que o app deu, pra dar pra saber por quê.
    if (opened.isPlaced) {
      if (!def) return { text: 'Abri o Radar do time. Configure a org e o time no painel.' }
      return { text: `Abri o Radar do time (${def.name}).` }
    }
    const why = `O painel não abriu (${opened.reason}).`
    if (!def) return { text: `${why} Configure a org e o time quando ele abrir.` }
    if (f.isGhMissing) return { text: `${why} Instale e faça login no GitHub CLI (\`gh auth login\`) para o radar funcionar.` }
    if (!f.updatedAt) return { text: `${why} Estou buscando os PRs e os cards agora.` }
    const v = await read($, view)

    return { text: `${why}\n\n${summary(def.members, f, v.range, await $.clock.now())}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Input } = $.ui.resolve(e)
    const waiting = await read($, alerts)
    const dismiss = (key: string) => update($, alerts, cur => cur.filter(x => x.key !== key))
    // Faixa dos PRs novos: clicar abre o PR no Chrome e tira o aviso; o ✕ só tira.
    const alertStrip = () =>
      waiting.length ? (
        <Box flexDirection="column" marginBottom={1} minWidth={0}>
          {waiting.map(a => (
            <Box key={`aviso:${a.key}`} flexDirection="row" alignItems="center" gap={1} minWidth={0}>
              <Text color="green">●</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Button
                  key={`aviso-abrir:${a.key}`}
                  plain
                  label={`${a.dev} abriu: ${a.what}`}
                  onPress={() => void openInChrome($, a.url).then(() => dismiss(a.key))}
                />
              </Box>
              <Button key={`aviso-fechar:${a.key}`} plain dimColor label="✕" onPress={() => void dismiss(a.key)} />
            </Box>
          ))}
        </Box>
      ) : null
    // A foto só aparece no desktop (Svg); no terminal o nome fica sozinho.
    const f = await read($, feed)
    const v = await read($, view)
    const cf = await read($, config)
    if (cf.isReady) setCfg(cf)
    const wz = await read($, wizard)
    const t = await read($, team)
    const def = teamById(t.id)
    const members = def?.members ?? []
    const now = await $.clock.now()
    const w = windowOf(v.range, now)
    const isThisWeek = v.range === 'semana'

    const setRange = (range: Range) => async () => {
      await update($, view, cur => ({ ...cur, range }))
      await $.store.set('periodo', range)
    }
    // Cada accordion (dev, projeto de um dev, "Outros" de um dev) tem um id; fechado = está na lista.
    const toggle = (id: string) => () =>
      void update($, view, cur => ({
        ...cur,
        collapsed: cur.collapsed.includes(id) ? cur.collapsed.filter(d => d !== id) : [...cur.collapsed, id],
      }))
    const arrow = (id: string) => (v.collapsed.includes(id) ? '▸' : '▾')

    // Acordeão dos devs: um aberto por vez. O app descarta o painel inteiro se a árvore passa de
    // 100 mil caracteres, e o time todo aberto chegava a 240 mil.
    const hasAnything = (dev: string) =>
      f.items.some(i => i.dev === dev && inRange(i, w)) || (isThisWeek && f.issues.some(i => i.dev === dev && isRecent(i, f.items, now)))
    const openDev = v.openDev ?? members.find(d => hasAnything(d.name))?.name
    const toggleDev = (dev: string) => () => void update($, view, cur => ({ ...cur, openDev: openDev === dev ? '' : dev }))
    const showAll = v.showAll ?? []
    const limited = (id: string, rows: RenderChildren[]) => {
      if (rows.length <= GROUP_LIMIT || showAll.includes(id)) return rows
      const more = rows.length - GROUP_LIMIT
      return [
        ...rows.slice(0, GROUP_LIMIT),
        <Button
          key={`mais:${id}`}
          plain
          dimColor
          label={`ver mais ${more}`}
          onPress={() => void update($, view, cur => ({ ...cur, showAll: [...(cur.showAll ?? []), id] }))}
        />,
      ]
    }

    // Hierarquia de cada item: 1) o que é, em texto normal; 2) status, data e link, pequeno;
    // 3) tamanho e notas, menor ainda e numa linha só (o motivo fica no fim, cortado se não couber).
    const levels = (s?: PrSize) =>
      s?.complexity || s?.care ? (
        <Text size="caption">
          <Text dimColor> · complexidade </Text>
          <Text color={levelColor(s.complexity)}>{s.complexity ?? '?'}</Text>
          <Text dimColor> · cuidado </Text>
          <Text color={levelColor(s.care)}>{careLabel(s.care)}</Text>
        </Text>
      ) : null

    const details = (s?: PrSize) =>
      s ? (
        <Text size="caption" dimColor wrap="truncate-end">
          +{num(s.additions)} −{num(s.deletions)} · {s.files} arq.{s.why ? ` · ${s.why}` : ''}
        </Text>
      ) : null

    const statusDot = (color: string, label: string) => (
      <Text size="caption">
        <Text color={color}>● </Text>
        <Text dimColor>{label}</Text>
      </Text>
    )

    const prRow = (i: PrItem) => (
      <Box key={i.key} flexDirection="column" marginBottom={1}>
        <Text size="footnote">{i.plain ?? i.title}</Text>
        <Box flexDirection="row" flexWrap="wrap">
          {statusDot(i.status === 'no ar' ? 'green' : 'yellow', `${statusLabel(i.status)} · ${shortDates(i)} · `)}
          <Text size="caption">
            <Link href={i.url} label={`#${i.number}`} />
          </Text>
          {i.ticket && i.ticketUrl ? (
            <Text size="caption">
              <Text dimColor> · card </Text>
              <Link href={i.ticketUrl} label={i.ticket} />
            </Text>
          ) : null}
          {levels(i.size)}
        </Box>
        {details(i.size)}
      </Box>
    )

    // Card em andamento; os PRs dele aparecem como linhas pequenas embaixo.
    const issueRow = (i: IssueItem, prs: PrItem[]) => (
      <Box key={i.id} flexDirection="column" marginBottom={1}>
        <Text size="footnote">{i.title}</Text>
        <Box flexDirection="row" flexWrap="wrap">
          {statusDot('cyan', `${statusLabel(i.status)} · ${issueDates(i, now)} · `)}
          <Text size="caption">
            <Link href={i.url} label={i.id} />
          </Text>
          {isStale(i, now) ? <Text size="caption" color="red"> · parado</Text> : null}
        </Box>
        {prs.map(pr => (
          <Box key={`${i.id}-${pr.key}`} flexDirection="row" flexWrap="wrap">
            <Text size="caption" dimColor>└ </Text>
            <Text size="caption">
              <Link href={pr.url} label={`PR #${pr.number}`} />
            </Text>
            <Text size="caption" dimColor> {statusLabel(pr.status)}</Text>
            {levels(pr.size)}
          </Box>
        ))}
      </Box>
    )

    const progressBlock = (p?: ProjectProgress) => {
      if (!p || p.total === 0) return null
      const pct = Math.round((p.done / p.total) * 100)
      return (
        <Box flexDirection="column" marginTop={1} minWidth={0}>
          <Box flexDirection="row" width="100%" overflow="hidden">
            {p.done > 0 ? (
              <Box flexGrow={p.done} backgroundColor="green">
                <Text size="caption"> </Text>
              </Box>
            ) : null}
            {p.total - p.done > 0 ? (
              <Box flexGrow={p.total - p.done} backgroundColor="gray">
                <Text size="caption"> </Text>
              </Box>
            ) : null}
          </Box>
          <Text size="caption" dimColor>
            <Text>{pct}%</Text> · {p.done} de {p.total} cards feitos{p.doing ? ` · ${p.doing} em andamento` : ''}
          </Text>
        </Box>
      )
    }

    const group = (
      id: string,
      title: string,
      count: string,
      body: RenderChildren[],
      opts: { link?: { href: string; label: string }; progress?: ProjectProgress } = {},
    ) => (
      <Box key={id} flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          <Button key={id} plain label={arrow(id)} dimColor onPress={toggle(id)} />
          <Box flexDirection="column" flexShrink={1} flexGrow={1} minWidth={0}>
            <Text weight="semibold">{title}</Text>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Text size="footnote" dimColor>{count}</Text>
              {opts.link ? (
                <Text size="footnote">
                  <Link href={opts.link.href} label={opts.link.label} />
                </Text>
              ) : null}
            </Box>
            {progressBlock(opts.progress)}
          </Box>
        </Box>
        {v.collapsed.includes(id) ? null : (
          <Box flexDirection="column" paddingLeft={5} marginTop={1} minWidth={0}>
            {limited(id, body)}
          </Box>
        )}
      </Box>
    )

    // Visão geral das entregas do dev no período (destaque na semana passada).
    const overviewLine = (prs: PrItem[]) => {
      const d = delivered(prs)
      if (d.count === 0) return 'nenhum PR foi pro ar'
      return `${plural(d.count, 'PR', 'PRs')} no ar · +${num(d.additions)} −${num(d.deletions)} linhas · ${d.files} arq.`
    }
    const overview = (prs: PrItem[]) => {
      const d = delivered(prs)
      if (d.count === 0) return null
      const dist = (pairs: readonly (readonly [Level, number])[]) =>
        pairs
          .filter(([, n]) => n > 0)
          .map(([l, n]) => (
            <Text key={l} color={levelColor(l)}>
              {n} {l}{' '}
            </Text>
          ))
      return (
        <Box flexDirection="column">
          <Text size="footnote">
            <Text dimColor>complexidade </Text>
            {dist(d.complexity)}
            <Text dimColor> · cuidado </Text>
            {dist(d.care)}
          </Text>
          {d.unsized > 0 ? <Text size="caption" dimColor>{d.unsized} PRs ainda sem medição.</Text> : null}
        </Box>
      )
    }


    const devBlock = (dev: string) => {
      const prs = f.items.filter(i => i.dev === dev && inRange(i, w))
      const doing = isThisWeek ? f.issues.filter(i => i.dev === dev && isRecent(i, f.items, now)) : []
      const doingIds = new Set(doing.map(i => i.id))
      const devId = `dev:${dev}`

      // Agrupa por projeto: cards em andamento + PRs do período. PR de um card em andamento vai junto do card.
      type G = { name?: string; label: string; link?: string; issues: IssueItem[]; prs: PrItem[] }
      const groups = new Map<string, G>()
      const groupFor = (key: string, init: () => G) => {
        const g = groups.get(key) ?? init()
        groups.set(key, g)
        return g
      }
      for (const i of doing) {
        const key = i.projectName ?? `card:${i.id}`
        groupFor(key, () => ({
          name: i.projectName,
          label: i.projectName ?? 'Sem projeto',
          link: i.project?.url,
          issues: [],
          prs: [],
        })).issues.push(i)
      }
      const others: PrItem[] = []
      for (const pr of prs) {
        if (pr.ticket && doingIds.has(pr.ticket)) continue
        if (!pr.ticket) {
          others.push(pr)
          continue
        }
        const key = pr.project?.name ?? `card:${pr.ticket}`
        groupFor(key, () => ({
          name: pr.project?.name,
          label: pr.project?.name ?? `Card ${pr.ticket}`,
          link: pr.project?.url ?? pr.ticketUrl,
          issues: [],
          prs: [],
        })).prs.push(pr)
      }
      const prsOfIssue = (id: string) => f.items.filter(pr => pr.ticket === id && pr.status !== 'fechado' && inRange(pr, w))

      const open = prs.filter(isOpen)
      const shipped = prs.filter(p => shippedIn(p, w))
      const shippedSum = delivered(shipped)
      // Linhas e arquivos só dos PRs já medidos; enquanto mede, mostra só a contagem.
      const shippedSize =
        shippedSum.count > shippedSum.unsized
          ? ` (+${num(shippedSum.additions)} −${num(shippedSum.deletions)} linhas · ${shippedSum.files} arq.)`
          : ''
      const headline = isThisWeek
        ? [
            `${plural(doing.length, 'card', 'cards')} em andamento`,
            `${plural(open.length, 'PR', 'PRs')} em review`,
            `${shipped.length} no ar${shippedSize}`,
          ].join(' · ')
        : overviewLine(shipped)

      return (
        <Box key={dev} flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} paddingY={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key={devId} plain label={openDev === dev ? '▾' : '▸'} onPress={toggleDev(dev)} />
            <Box flexDirection="column" flexShrink={1} flexGrow={1} minWidth={0}>
              <Text>
                <Text bold>{dev}</Text>
                {members.find(d => d.name === dev)?.role === 'pm' ? <Text size="caption" dimColor>{' PM'}</Text> : null}
                <Text dimColor>{'  '}{headline}</Text>
              </Text>
              {isThisWeek ? null : overview(shipped)}
            </Box>
          </Box>
          {openDev !== dev ? null : (
            <Box flexDirection="column" paddingLeft={2} minWidth={0}>
              {f.updatedAt && groups.size === 0 && others.length === 0 && isThisWeek ? (
                <Text dimColor>Nada nesse período.</Text>
              ) : null}
              {[...groups.entries()].map(([key, g]) => {
                const count = [
                  g.issues.length ? `${g.issues.length} em andamento` : undefined,
                  g.prs.length ? plural(g.prs.length, 'PR', 'PRs') : undefined,
                ]
                  .filter(Boolean)
                  .join(', ')
                return group(
                  `proj:${dev}:${key}`,
                  g.label,
                  count,
                  [...g.issues.map(i => issueRow(i, prsOfIssue(i.id))), ...g.prs.map(prRow)],
                  {
                    link: g.link ? { href: g.link, label: 'abrir no Linear' } : undefined,
                    progress: g.name ? f.progress[g.name] : undefined,
                  },
                )
              })}
              {/* PRs sem card no Linear: um grupo por repositório. */}
              {[...new Set(others.map(p => p.repo))].map(repo => {
                const list = others.filter(p => p.repo === repo)
                return group(`outros:${dev}:${repo}`, repo, `${plural(list.length, 'PR', 'PRs')} · fora do Linear`, list.map(prRow), {
                  link: { href: `https://github.com/${cfg.org}/${repo}`, label: 'abrir no GitHub' },
                })
              })}
            </Box>
          )}
        </Box>
      )
    }

    if (!t.isReady || !cf.isReady || !wz.isReady) return <Text dimColor>Carregando…</Text>

    const setW = (fn: (w: Wizard) => Wizard) => void update($, wizard, fn)
    const openSetup = () => void update($, wizard, () => ({ ...emptyWizard(cfg), isOpen: true }))

    if (wz.isOpen) {
      const hasConfig = !!cfg.org && cfg.teams.length > 0
      const pickedLogins = Object.keys(wz.picked)
      const filter = wz.filter.trim().toLowerCase()
      const matches = wz.available.filter(l => !filter || l.toLowerCase().includes(filter))
      const shown = matches.slice(0, 40)

      // Os botões leem o rascunho de agora (não o do último desenho), porque o texto muda a cada tecla.
      // Enter entrega o texto na hora; o que o Input já avisou por tecla está no rascunho.
      const goTimes = async (patch: Partial<Wizard> = {}) => {
        const cur = { ...(await read($, wizard)), ...patch }
        const org = cur.org.trim()
        if (!isOrg(org)) return setW(w => ({ ...w, ...patch, error: 'Digite o nome da org do GitHub (só letras, números e hífen).' }))
        membersRequest = org
        setW(w => ({ ...w, ...patch, org, step: 'times', error: undefined, isLoading: true, available: [] }))
      }

      const togglePerson = (login: string) => () =>
        setW(w => {
          const picked = { ...w.picked }
          if (picked[login]) delete picked[login]
          else picked[login] = { name: login, linear: '', isPm: false }
          return { ...w, picked }
        })
      const patchPerson = (login: string, patch: Partial<{ name: string; linear: string; isPm: boolean }>) =>
        setW(w => (w.picked[login] ? { ...w, picked: { ...w.picked, [login]: { ...w.picked[login], ...patch } } } : w))
      const addManual = (value: string) => {
        const login = value.trim().replace(/^@/, '')
        if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)) return
        setW(w => ({
          ...w,
          available: w.available.includes(login) ? w.available : [...w.available, login].sort((a, b) => a.localeCompare(b)),
          picked: w.picked[login] ? w.picked : { ...w.picked, [login]: { name: login, linear: '', isPm: false } },
          filter: '',
        }))
      }

      // Põe o time em montagem na lista; devolve a lista nova (ou o motivo de não dar).
      const withDraft = (w: Wizard): { teams?: TeamDef[]; error?: string } => {
        const name = w.draftName.trim()
        const logins = Object.keys(w.picked)
        if (!name) return { error: 'Dê um nome ao time.' }
        if (!logins.length) return { error: 'Marque pelo menos uma pessoa do time.' }
        const members: Member[] = logins.map(login => {
          const p = w.picked[login] as { name: string; linear: string; isPm: boolean }
          return { login, name: p.name.trim() || login, linear: p.linear.trim(), ...(p.isPm ? { role: 'pm' as const } : {}) }
        })
        const others = w.teams.filter(x => x.id !== w.draftId)
        let id = w.draftId ?? slug(name)
        if (!w.draftId) for (let n = 2; others.some(x => x.id === id) || id === 'todos'; n++) id = `${slug(name)}-${n}`
        const next: TeamDef = { id, name, members }
        return { teams: w.draftId ? w.teams.map(x => (x.id === w.draftId ? next : x)) : [...others, next] }
      }
      const clearDraft = { draftId: undefined, draftName: '', picked: {}, filter: '' }
      const saveDraft = () =>
        setW(w => {
          const r = withDraft(w)
          return r.teams ? { ...w, ...clearDraft, teams: r.teams, error: undefined } : { ...w, error: r.error }
        })
      const finish = async () => {
        const wz = await read($, wizard)
        let teams = wz.teams
        if (wz.draftName.trim() || Object.keys(wz.picked).length) {
          const r = withDraft(wz)
          if (!r.teams) return setW(w => ({ ...w, error: r.error }))
          teams = r.teams
        }
        if (!teams.length) return setW(w => ({ ...w, error: 'Monte pelo menos um time antes de concluir.' }))
        await saveConfig($, { org: wz.org.trim(), workspace: wz.workspace.trim(), extraTerms: wz.extraTerms.trim(), teams })
        setW(w => ({ ...w, ...clearDraft, isOpen: false, step: 'org', teams, error: undefined }))
      }
      const editTeam = (x: TeamDef) => () =>
        setW(w => ({
          ...w,
          draftId: x.id,
          draftName: x.name,
          filter: '',
          picked: Object.fromEntries(x.members.map(m => [m.login, { name: m.name, linear: m.linear, isPm: m.role === 'pm' }])),
          available: [...new Set([...w.available, ...x.members.map(m => m.login)])].sort((a, b) => a.localeCompare(b)),
        }))
      const removeTeam = (id: string) => () => setW(w => ({ ...w, teams: w.teams.filter(x => x.id !== id) }))

      if (wz.step === 'org') {
        return (
          <Box flexDirection="column" gap={1}>
            <Text weight="semibold">{hasConfig ? 'Configurar o radar' : 'Vamos configurar o radar do seu time'}</Text>
            <Text dimColor size="footnote">
              O radar usa o GitHub CLI (gh) já logado na sua máquina. Tudo que você digitar aqui fica só no seu computador.
            </Text>
            <Input
              key="cfg-org"
              label="Org do GitHub: "
              placeholder="minha-empresa"
              value={wz.org}
              onInput={v => setW(w => ({ ...w, org: v }))}
              onSubmit={v => void goTimes({ org: v })}
            />
            <Input
              key="cfg-workspace"
              label="Workspace do Linear (opcional): "
              placeholder="o trecho de linear.app/<workspace>"
              value={wz.workspace}
              onInput={v => setW(w => ({ ...w, workspace: v }))}
              onSubmit={v => void goTimes({ workspace: v })}
            />
            <Input
              key="cfg-termos"
              label="Termos sensíveis extras (opcional): "
              placeholder="separados por vírgula, ex.: fidelidade, cashback"
              value={wz.extraTerms}
              onInput={v => setW(w => ({ ...w, extraTerms: v }))}
              onSubmit={v => void goTimes({ extraTerms: v })}
            />
            <Text dimColor size="footnote">
              Sem o workspace do Linear, o radar mostra só os PRs do GitHub. Os termos extras ajudam a marcar PRs que mexem em áreas importantes do seu negócio.
            </Text>
            {wz.error ? <Text color="red">{wz.error}</Text> : null}
            <Box flexDirection="row" gap={1}>
              <Button key="cfg-continuar" label="continuar" variant="primary" onPress={() => void goTimes()} />
              {hasConfig ? (
                <Button key="cfg-cancelar" label="cancelar" onPress={() => setW(w => ({ ...w, isOpen: false }))} />
              ) : null}
            </Box>
          </Box>
        )
      }

      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Times de {wz.org}</Text>
          {wz.teams.length ? (
            <Box flexDirection="column">
              {wz.teams.map(x => (
                <Box key={`cfg-time-${x.id}`} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Text>
                    {x.name}
                    <Text dimColor> · {plural(x.members.length, 'pessoa', 'pessoas')}</Text>
                  </Text>
                  <Button key={`cfg-editar-${x.id}`} plain label="editar" dimColor onPress={editTeam(x)} />
                  <Button key={`cfg-remover-${x.id}`} plain label="remover" dimColor onPress={removeTeam(x.id)} />
                </Box>
              ))}
            </Box>
          ) : (
            <Text dimColor size="footnote">Nenhum time ainda. Dê um nome, marque as pessoas e salve.</Text>
          )}

          <Text weight="semibold">{wz.draftId ? 'Editando time' : 'Novo time'}</Text>
          <Input
            key="cfg-nome-time"
            label="Nome do time: "
            placeholder="ex.: Produto"
            value={wz.draftName}
            onInput={v => setW(w => ({ ...w, draftName: v }))}
            onSubmit={v => setW(w => ({ ...w, draftName: v }))}
          />
          {wz.isLoading ? <Text dimColor>Buscando os membros de {wz.org}…</Text> : null}
          {wz.error ? <Text color="yellow">{wz.error}</Text> : null}
          <Input
            key="cfg-filtro"
            label="Buscar pessoa: "
            placeholder={`${wz.available.length} membros`}
            value={wz.filter}
            onInput={v => setW(w => ({ ...w, filter: v }))}
            onSubmit={addManual}
          />
          <Text dimColor size="footnote">Enter com um login que não está na lista adiciona a pessoa à mão.</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {shown.map(l => (
              <Button
                key={`pessoa-${l}`}
                label={wz.picked[l] ? `✓ ${l}` : l}
                variant={wz.picked[l] ? 'primary' : 'secondary'}
                onPress={togglePerson(l)}
              />
            ))}
          </Box>
          {matches.length > shown.length ? (
            <Text dimColor size="footnote">Mostrando {shown.length} de {matches.length}. Use a busca para achar as outras.</Text>
          ) : null}

          {pickedLogins.length ? (
            <Box flexDirection="column" gap={1}>
              <Text dimColor size="footnote">Como cada pessoa aparece no painel. O e-mail do Linear é opcional.</Text>
              {pickedLogins.map(l => {
                const p = wz.picked[l] as { name: string; linear: string; isPm: boolean }
                return (
                  <Box key={`cfg-pessoa-${l}`} flexDirection="column">
                    <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                      <Text dimColor>{l}</Text>
                      <Button
                        key={`pm-${l}`}
                        label={p.isPm ? '✓ PM' : 'PM'}
                        variant={p.isPm ? 'primary' : 'secondary'}
                        onPress={() => patchPerson(l, { isPm: !p.isPm })}
                      />
                    </Box>
                    <Input
                      key={`nome-${l}`}
                      label="Nome: "
                      value={p.name}
                      onInput={v => patchPerson(l, { name: v })}
                      onSubmit={v => patchPerson(l, { name: v })}
                    />
                    <Input
                      key={`email-${l}`}
                      label="E-mail no Linear: "
                      placeholder="opcional"
                      value={p.linear}
                      onInput={v => patchPerson(l, { linear: v })}
                      onSubmit={v => patchPerson(l, { linear: v })}
                    />
                  </Box>
                )
              })}
            </Box>
          ) : null}

          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="cfg-salvar-time" label={wz.draftId ? 'salvar alterações' : 'salvar time'} onPress={saveDraft} />
            <Button key="cfg-concluir" label="concluir" variant="primary" onPress={() => void finish()} />
            <Button key="cfg-voltar" label="voltar" onPress={() => setW(w => ({ ...w, step: 'org', error: undefined }))} />
            {hasConfig ? (
              <Button key="cfg-cancelar-times" label="cancelar" onPress={() => setW(w => ({ ...w, isOpen: false }))} />
            ) : null}
          </Box>
        </Box>
      )
    }

    if (!def || t.isChoosing) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Qual é o seu time?</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {choices().map(x => (
              <Button
                key={`time-${x.id}`}
                label={x.name}
                variant={x.id === t.id ? 'primary' : 'secondary'}
                onPress={() => void pick($, x.id)}
              />
            ))}
          </Box>
          <Button key="cfg-abrir" plain dimColor label="configurar" onPress={openSetup} />
          {def ? (
            <Button key="time-voltar" plain label="voltar" onPress={() => void update($, team, c => ({ ...c, isChoosing: false }))} />
          ) : null}
        </Box>
      )
    }

    // Carregando: ícone girando (só no desktop), etapa atual e barra de progresso.
    const spinner = () => {
      if (e.surface !== 'desktop') return null
      const { Svg: Pic } = $.ui.resolve({ ...e, surface: 'desktop' as const })
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">` +
        `<circle cx="7" cy="7" r="5.5" fill="none" stroke="#888" stroke-opacity="0.3" stroke-width="2"/>` +
        `<path d="M7 1.5 A5.5 5.5 0 0 1 12.5 7" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round">` +
        `<animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.9s" repeatCount="indefinite"/>` +
        `</path></svg>`
      return <Pic source={svg} alt="carregando" width={14} height={14} />
    }
    const loadingBlock = () => {
      const l = f.loading
      const label = l?.label ?? 'Começando a busca'
      const count = l && l.total > 0 ? ` · ${l.done} de ${l.total}` : ''
      return (
        <Box flexDirection="column" gap={1} minWidth={0}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {spinner()}
            <Text size="footnote">
              {label}
              <Text dimColor>{count}</Text>
            </Text>
          </Box>
          {l && l.total > 0 ? (
            <Box flexDirection="row" width="100%" overflow="hidden">
              {l.done > 0 ? (
                <Box flexGrow={l.done} backgroundColor="blue">
                  <Text size="caption"> </Text>
                </Box>
              ) : null}
              {l.total - l.done > 0 ? (
                <Box flexGrow={l.total - l.done} backgroundColor="gray">
                  <Text size="caption"> </Text>
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" gap={1} marginBottom={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>Time {def.name}</Text>
            {cfg.teams.length > 1 ? (
              <Button key="time-trocar" plain label="trocar" dimColor onPress={() => void update($, team, c => ({ ...c, isChoosing: true }))} />
            ) : null}
            <Button key="cfg-abrir" plain label="configurar" dimColor onPress={openSetup} />
          </Box>
          <Box flexDirection="row" gap={1}>
            {RANGES.map(r => (
              <Button
                key={`periodo-${r.id}`}
                label={r.label}
                variant={r.id === v.range ? 'primary' : 'secondary'}
                dimColor={r.id !== v.range}
                onPress={setRange(r.id)}
              />
            ))}
            <Button key="atualizar" plain label="↻" onPress={() => requestRefresh({ isManual: true })} />
          </Box>
          {f.isLoading ? (
            loadingBlock()
          ) : (
            <Text dimColor size="footnote">{f.updatedAt ? `Atualizado às ${hhmm(f.updatedAt)}` : 'Ainda não carregou'}</Text>
          )}
        </Box>
        {f.isGhMissing ? <Text color="yellow">Instale e faça login no GitHub CLI (`gh auth login`)</Text> : null}
        {f.isGhMissing && f.ghDetail ? <Text dimColor size="footnote">{f.ghDetail}</Text> : null}
        {alertStrip()}
        {f.error && !f.isGhMissing ? <Text color="red">Não consegui ler o GitHub: {f.error}</Text> : null}
        {f.isLinearMissing ? <Text color="yellow">Conecte o Linear no Claude pra ver os cards (ou tire o workspace na configuração)</Text> : null}
        {f.linearError ? <Text color="yellow">{f.linearError}</Text> : null}
        {f.isGhMissing ? null : members.map(d => devBlock(d.name))}
      </Box>
    )
  })
}
