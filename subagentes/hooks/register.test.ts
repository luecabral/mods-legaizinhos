import { expect, test } from 'claude-code/testing'

import { bar, barColor, withMerged, costOf, diffOf, effortLabel, limitLabel, mainFromLedger, resetText, thousands, geminiCall, mergeFlow, parseFlow, parseStatus, etimeSeconds, isWrapper, recentTasks, stateOf, titleOf } from './register'
import type { Run } from '../types'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'a1',
  type: 'general-purpose',
  description: 'x',
  model: '',
  startedAt: 0,
  steps: 1,
  tools: 0,
  byModel: {},
  added: 0,
  removed: 0,
  files: [],
  ...over,
})

test('custo soma por modelo, Claude e Gemini, e separa modelo sem preço', async () => {
  const c = costOf(
    run({
      byModel: {
        'claude-sonnet-5-5': { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.5-flash': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        'modelo-x': { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
    }),
  )
  expect(Math.round(c.usd * 1000) / 1000).toBe(4.8)
  expect(c.unpriced).toEqual(['modelo-x'])
})

test('diff usa gitDiff quando há, senão conta o patch', async () => {
  expect(diffOf({ filePath: 'a.rb', gitDiff: { additions: 4, deletions: 2 } })).toEqual({
    file: 'a.rb',
    added: 4,
    removed: 2,
  })
  expect(diffOf({ filePath: 'b.rb', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] })).toEqual({
    file: 'b.rb',
    added: 2,
    removed: 1,
  })
})

test('reconhece script/gemini-dev, o esforço e o modelo, e ignora o que só cita o script', async () => {
  expect(geminiCall('script/gemini-dev cep-entrega tmp/gemini-dev/cep-entrega.md origin/main pesado')).toEqual({
    name: 'cep-entrega',
    taskPath: 'tmp/gemini-dev/cep-entrega.md',
    effort: 'pesado',
    model: 'gemini-4-argon',
  })
  expect(geminiCall('script/gemini-dev x tmp/x.md')).toEqual({
    name: 'x',
    taskPath: 'tmp/x.md',
    effort: 'leve',
    model: 'gemini-3.8-flash',
  })
  expect(geminiCall('GEMINI_MODEL=gemini-2.5-pro script/gemini-dev x tmp/x.md')?.model).toBe('gemini-2.5-pro')
  expect(geminiCall('bin/rails test')).toBeUndefined()
  expect(geminiCall('cat script/gemini-dev | head -5')).toBeUndefined()
  expect(geminiCall('ls script/gemini-dev | grep x')).toBeUndefined()
})

const flowText = [
  '{"type":"init","timestamp":"2026-11-10T10:00:00.000Z","model":"gemini-4-argon"}',
  '{"type":"tool_use","timestamp":"2026-11-10T10:00:01.000Z","tool_name":"read_file","parameters":{"file_path":"/w/app/a.rb"}}',
  '{"type":"tool_use","timestamp":"2026-11-10T10:00:02.000Z","tool_name":"write_file","parameters":{"file_path":"/w/app/b.rb"}}',
  '{"type":"tool_use","timestamp":"2026-11-10T10:00:03.000Z","tool_name":"run_shell_command","parameters":{"command":"bin/rubocop   app/b.rb"}}',
  'linha quebrada',
  '{"type":"result","timestamp":"2026-11-10T10:00:09.000Z","status":"success","stats":{"models":{"gemini-4-argon":{"input_tokens":1000,"output_tokens":200,"cached":400,"input":600}}}}',
].join('\n')

test('lê o arquivo de eventos: ações, última ação, arquivos e tokens', async () => {
  const f = parseFlow(flowText)
  expect(f.actions).toBe(3)
  expect(f.last?.text).toBe('Rodando bin/rubocop app/b.rb')
  expect(f.files).toEqual(['/w/app/b.rb'])
  expect(f.model).toBe('gemini-4-argon')
  expect(f.status).toBe('success')
  expect(f.byModel['gemini-4-argon']).toEqual({ input: 600, output: 200, cacheRead: 400, cacheWrite: 0 })
})

test('a tarefa vira pronta quando o fluxo traz o resultado, e o status final traz o diff', async () => {
  const r = run({ startedAt: 1000, flowPath: 'tmp/gemini-dev/x.jsonl', external: true })
  const m = mergeFlow(r, parseFlow(flowText))
  expect(m.exit).toBe(0)
  expect(stateOf(m, Date.now())).toBe('completed')
  const st = parseStatus('{"exit":0,"files":["app/b.rb"],"added":5,"removed":1}')
  const done = mergeFlow(r, parseFlow(flowText), st)
  expect(done.files).toEqual(['app/b.rb'])
  expect([done.added, done.removed]).toEqual([5, 1])
})

test('sem eventos há mais de 5 minutos a tarefa fica sem sinal; recente continua rodando', async () => {
  const r = run({ startedAt: 0, external: true })
  expect(stateOf(r, 60_000)).toBe('running')
  expect(stateOf(r, 6 * 60_000)).toBe('stale')
  expect(stateOf({ ...r, exit: 1, endedAt: 5 }, 6 * 60_000)).toBe('failed')
})

test('acha as tarefas recentes em tmp/gemini-dev pelos arquivos .jsonl ou .log', async () => {
  const now = 100 * 3600_000
  const names = recentTasks(
    [
      { name: 'a.jsonl', mtimeMs: now - 1000 },
      { name: 'a.status.json', mtimeMs: now - 500 },
      { name: 'b.log', mtimeMs: now - 2 * 3600_000 },
      { name: 'velha.log', mtimeMs: now - 20 * 3600_000 },
      { name: 'c.md', mtimeMs: now },
    ],
    now,
  )
  expect(names.sort()).toEqual(['a', 'b'])
})

test('sinal recente do Gemini mantém a tarefa rodando mesmo sem ação nova', async () => {
  const r = run({ startedAt: 0, external: true, activityAt: 9 * 60_000 })
  expect(stateOf(r, 10 * 60_000)).toBe('running')
  expect(stateOf(r, 20 * 60_000)).toBe('stale')
})

test('título do card: usa "Tarefa:" e ignora a linha "Nome:"', async () => {
  expect(titleOf('Nome: central-seo\nTarefa: SEO da Central de Ajuda pública\nmais coisas')).toBe('SEO da Central de Ajuda pública')
  expect(titleOf('# Criar b.rb com a regra X\ncorpo')).toBe('Criar b.rb com a regra X')
  expect(titleOf('Nome: so-o-nome')).toBeUndefined()
})

test('etime do ps vira segundos', async () => {
  expect(etimeSeconds('04:05')).toBe(245)
  expect(etimeSeconds('03:04:05')).toBe(11045)
  expect(etimeSeconds('2-03:04:05')).toBe(183845)
  expect(etimeSeconds('lixo')).toBeUndefined()
})

test('o subagente que só despacha o Gemini não vira card', async () => {
  expect(isWrapper(run({ type: 'gemini-dev', description: 'x' }))).toBe(true)
  expect(isWrapper(run({ type: 'general-purpose', description: 'Gemini T4 personalizar Central' }))).toBe(true)
  expect(isWrapper(run({ type: 'general-purpose', description: 'Revisar T2 SEO' }))).toBe(false)
})

test('principal pelo /cost é o total menos os subagentes, nunca negativo', async () => {
  expect(mainFromLedger(10, 3.5)).toBe(6.5)
  expect(mainFromLedger(1, 2)).toBe(0)
  expect(mainFromLedger(undefined, 2)).toBe(undefined)
})

test('esforço em português; Gemini e desconhecido passam como vieram', async () => {
  expect(effortLabel('high')).toBe('esforço alto')
  expect(effortLabel('xhigh')).toBe('esforço muito alto')
  expect(effortLabel('pesado')).toBe('esforço pesado')
  expect(effortLabel(undefined)).toBe('')
})

test('milhar com ponto', async () => {
  expect(thousands(1155)).toBe('1.155')
  expect(thousands(252)).toBe('252')
  expect(thousands(1234567)).toBe('1.234.567')
})

test('barra de limite: proporcional, travada em 0 e 100, cor por faixa', async () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(120, 4)).toBe('████')
  expect(bar(-5, 4)).toBe('░░░░')
  expect([barColor(10), barColor(75), barColor(95)]).toEqual(['green', 'yellow', 'red'])
  expect(limitLabel('seven_day')).toBe('Limite semanal')
  expect(limitLabel('outro')).toBe('outro')
})

test('reinício: no mesmo dia mostra a hora; dias depois, o dia da semana', async () => {
  const now = new Date(2026, 10, 11, 10, 0).getTime()
  expect(resetText(new Date(2026, 10, 11, 12, 30).toISOString(), now)).toBe('reinicia às 12:30 · em 2 h 30 min')
  expect(resetText(new Date(2026, 10, 13, 9, 0).toISOString(), now)).toBe('reinicia sex 09:00 · em 1 d 23 h')
  expect(resetText('lixo', now)).toBe('')
})

test('mescladas: o guardado continua e o que acabou de mesclar entra', async () => {
  const kid = { id: 'k2', title: 'B', running: false, archived: false, detached: false, merged: true,
    figures: { usd: 2, tokens: 20, added: 0, removed: 0, updatedAt: 0 } }
  const out = withMerged({ k1: { id: 'k1', title: 'A', usd: 1, tokens: 10 } }, [kid, { ...kid, id: 'k3', merged: false }])
  expect(Object.keys(out)).toEqual(['k1', 'k2'])
  expect(out.k2).toEqual({ id: 'k2', title: 'B', usd: 2, tokens: 20 })
})
