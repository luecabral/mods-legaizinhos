import { describe, expect, test } from 'claude-code/testing'

import { cliRun, isAlive, parseSummaries, projectOf } from './gemini-cli'
import { sameAsTask } from './register'

const summary = {
  path: '/h/.gemini/tmp/homolog/chats/session-x.jsonl',
  sessionId: 'abc',
  start: '2026-11-11T13:59:00.000Z',
  title: 'Your job is to FIND BUGS',
  model: 'gemini-4-argon',
  tokens: { input: 1000, output: 50, cached: 600, thoughts: 20 },
  actions: 3,
  last: { name: 'read_file', args: { file_path: 'app/x.rb' }, at: '2026-11-11T14:00:00.000Z' },
  files: [],
}
const start = Date.parse(summary.start)

describe('gemini cli', () => {
  test('lê uma linha JSON por arquivo e ignora o resto', () => {
    expect(parseSummaries(`${JSON.stringify(summary)}\nlixo\n`).length).toBe(1)
  })
  test('projeto vem da pasta acima de chats', () => {
    expect(projectOf(summary.path)).toBe('homolog')
  })
  test('rodando quando um processo começou pouco antes da sessão', () => {
    expect(isAlive(start, [start - 3000])).toBe(true)
    expect(isAlive(start, [start - 10 * 60_000])).toBe(false)
    expect(isAlive(start, [start + 60_000])).toBe(false)
  })
  test('vira card: tokens sem o cache, pensamento conta como saída', () => {
    const run = cliRun(summary, start + 60_000, [start - 2000], start + 70_000, t => t)
    expect(run.endedAt).toBe(undefined)
    expect(run.byModel['gemini-4-argon']).toEqual({ input: 400, output: 70, cacheRead: 600, cacheWrite: 0 })
    expect(run.description).toBe('homolog')
  })
  test('sem processo vivo, termina no último toque do arquivo', () => {
    const run = cliRun(summary, start + 60_000, [], start + 70_000, t => t)
    expect(run.endedAt).toBe(start + 60_000)
  })
  test('não repete a tarefa do script', () => {
    const run = cliRun(summary, start, [], start, t => t)
    expect(sameAsTask({ ...run, description: 'gemini-fix' }, [{ ...run, description: 'fix', startedAt: 0 }])).toBe(true)
    expect(sameAsTask(run, [{ ...run, startedAt: start + 30_000 }])).toBe(true)
    expect(sameAsTask(run, [{ ...run, description: 'outra', startedAt: start + 5 * 60_000 }])).toBe(false)
  })
})

import { cliCall, fromHere } from './register'

describe('só o Gemini desta sessão', () => {
  test('reconhece a chamada direta ao CLI e ignora menções', () => {
    expect(cliCall('gemini -m gemini-4-argon --skip-trust -p "x"')).toBe(true)
    expect(cliCall('cd app && GEMINI_API_KEY=1 /opt/homebrew/bin/gemini -p "x"')).toBe(true)
    expect(cliCall('timeout 600 gemini -p "x" > out.txt')).toBe(true)
    expect(cliCall('grep -r gemini app/')).toBe(false)
    expect(cliCall('ls ~/.gemini/tmp')).toBe(false)
    expect(cliCall('script/gemini-dev fix tmp/x.md')).toBe(false)
  })
  test('execução do CLI conta quando começou durante um comando daqui', () => {
    const run = cliRun(summary, start, [], start, t => t)
    expect(fromHere(run, [{ at: start - 2000, end: start - 1000 }])).toBe(true)
    expect(fromHere(run, [{ at: start - 10 * 60_000, end: start - 9 * 60_000 }])).toBe(false)
    expect(fromHere(run, [])).toBe(false)
    expect(fromHere(run, [{ at: start - 2000, task: 'fix' }])).toBe(false)
  })
  test('tarefa do script conta pelo nome', () => {
    const run = { ...cliRun(summary, start, [], start, t => t), id: 'gemini:fix', description: 'fix' }
    expect(fromHere(run, [{ at: 0, task: 'fix' }])).toBe(true)
    expect(fromHere(run, [{ at: 0, task: 'outra' }])).toBe(false)
  })
})
