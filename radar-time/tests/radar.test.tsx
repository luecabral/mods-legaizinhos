import { expect, mock, test } from 'claude-code/testing'
import { pushAlerts } from '../hooks/register'

const PANE = {
  plugin: 'radar-time',
  component: 'Pane',
  requestId: 'radar-time',
  props: { title: 'Radar do time', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const NOW = Date.parse('2026-11-12T15:00:00Z')
const CONFIG = {
  org: 'acme',
  workspace: '',
  extraTerms: '',
  teams: [
    { id: 'produto', name: 'Produto', members: [{ login: 'ana-dev', name: 'Ana', linear: '' }, { login: 'bia-pm', name: 'Bia', linear: '', role: 'pm' }] },
    { id: 'infra', name: 'Infra', members: [{ login: 'caio-ops', name: 'Caio', linear: '' }] },
  ],
}

// O que fica embaixo dos plugins: relógio, store, comando, ferramentas e processos (gh) respondidos aqui.
function world(on: Parameters<Parameters<typeof test>[1]>[1], store: Record<string, unknown>, tools: string[] = []) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list' as never, (() => ({ value: tools.map(name => ({ name, description: '', mcp: true })) })) as never)
  on('process.run' as never, ((_: unknown, e: { argv?: string[]; command?: string[] }) => {
    const argv = (e.argv ?? e.command ?? []) as string[]
    const stdout = argv[0]?.includes('sh') ? '/home/x\n/usr/bin/gh\n' : argv.includes('api') ? 'ana-dev\nbia-pm\ncaio-ops\n' : '[]'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return clock
}


test('sem configuração, pede a org do GitHub e não mostra ninguém', async ($, on) => {
  world(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Vamos configurar o radar/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /continuar/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Qual é o seu time/ })).toBeFalsy()
  await ui.unmount()
})

test('primeira configuração: org, membros da org, time com PM, salva no store', async ($, on) => {
  const clock = world(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // org inválida não avança
  await ui.input({ key: 'cfg-org', text: 'org com espaço' })
  expect(await ui.find({ type: 'Text', text: /nome da org do GitHub/ })).toBeTruthy()

  await ui.input({ key: 'cfg-org', text: 'acme' }) // Enter avança
  await clock.advance(2000)
  await clock.advance(2000)
  expect(await ui.find({ type: 'Button', text: /ana-dev/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /caio-ops/ })).toBeTruthy()

  await ui.input({ key: 'cfg-nome-time', text: 'Produto' })
  await ui.press({ key: 'pessoa-ana-dev' })
  await ui.press({ key: 'pessoa-bia-pm' })
  await ui.input({ key: 'nome-ana-dev', text: 'Ana' })
  await ui.input({ key: 'nome-bia-pm', text: 'Bia' })
  await ui.press({ key: 'pm-bia-pm' })
  await ui.press({ key: 'cfg-concluir' })
  await clock.advance(2000)

  // Só tem um time: já abre nele, com as duas pessoas.
  expect(await ui.find({ type: 'Text', text: /Time Produto/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Ana/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Bia/ })).toBeTruthy()
  // Sem Linear configurado: sem aviso nenhum sobre Linear.
  expect(await ui.find({ type: 'Text', text: /Linear/ })).toBeFalsy()
  await ui.unmount()

  // Ficou salvo: ao recomeçar a sessão, não pede configuração de novo.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: /Vamos configurar o radar/ })).toBeFalsy()
  expect(await again.find({ type: 'Text', text: /Time Produto/ })).toBeTruthy()
  await again.unmount()
})

test('com dois times, pergunta qual é o time e oferece Todos', async ($, on) => {
  world(on, { 'config-1': CONFIG })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Qual é o seu time/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Infra/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Todos/ })).toBeTruthy()
  await ui.press({ key: 'time-todos' })
  for (const nome of ['Ana', 'Bia', 'Caio']) expect(await ui.find({ type: 'Text', text: new RegExp(nome) })).toBeTruthy()
  await ui.unmount()
})

test('dá para editar a configuração depois', async ($, on) => {
  const clock = world(on, { 'config-1': CONFIG, time: 'infra' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Time Infra/ })).toBeTruthy()

  await ui.press({ key: 'cfg-abrir' })
  expect(await ui.find({ type: 'Text', text: /Configurar o radar/ })).toBeTruthy()
  await ui.press({ key: 'cfg-continuar' })
  await clock.advance(2000)
  await ui.press({ key: 'cfg-editar-infra' })
  await ui.input({ key: 'nome-caio-ops', text: 'Caio Silva' })
  await ui.press({ key: 'cfg-salvar-time' })
  await ui.press({ key: 'cfg-concluir' })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /Caio Silva/ })).toBeTruthy()
  await ui.unmount()
})

test('com workspace do Linear mas sem o conector, avisa e segue só com o GitHub', async ($, on) => {
  world(on, { 'config-1': { ...CONFIG, workspace: 'acme-ws' }, time: 'produto' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Conecte o Linear no Claude/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Ana/ })).toBeTruthy()
  await ui.unmount()
})

test('carrega os PRs do time pela org configurada', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'config-1': CONFIG, time: 'produto' })
  const searches: string[][] = []
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list' as never, (() => ({ value: [] })) as never)
  on('model.complete' as never, (() => ({ value: { isAnswered: true, text: '{"1":"Carrinho não esvazia mais"}' } })) as never)
  const PR = { repository: { name: 'app', nameWithOwner: 'acme/app' }, number: 1, title: 'Corrige carrinho', state: 'open', isDraft: false, createdAt: '2026-11-11T12:00:00Z', closedAt: '', url: 'https://x/1', body: '' }
  on('process.run' as never, ((_: unknown, e: { argv?: string[]; command?: string[] }) => {
    const argv = (e.argv ?? e.command ?? []) as string[]
    if (argv.includes('search')) searches.push(argv)
    const isSearch = argv.includes('search') && argv.includes('ana-dev')
    const isView = argv.includes('view')
    const stdout = isSearch ? JSON.stringify([PR]) : isView ? JSON.stringify({ additions: 1, deletions: 1, changedFiles: 1, files: [] }) : '[]'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Carrinho não esvazia/ })).toBeTruthy()
  expect(searches.every(a => a.includes('acme'))).toBe(true)
  await ui.unmount()
})

test('avisos de PR novo: o mais novo vem primeiro, sem repetir e no máximo 5', async () => {
  const a = (n: number) => ({ key: `pr${n}`, dev: 'Ana', what: `PR ${n}`, url: `https://github.com/x/y/pull/${n}` })
  expect(pushAlerts([a(1), a(2)], [a(3), a(1)]).map(x => x.key)).toEqual(['pr3', 'pr1', 'pr2'])
  expect(pushAlerts([a(1), a(2), a(3), a(4)], [a(5), a(6)]).map(x => x.key)).toEqual(['pr5', 'pr6', 'pr1', 'pr2', 'pr3'])
})

// Sem configuração nada de empresa nenhuma aparece no painel: tudo vem do $.store.
test('painel de primeira vez não traz dados de nenhuma empresa', async ($, on) => {
  world(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const proibidos = [['res', 'erva'], ['rsv', 'ink'], ['lue', 'cabral'], ['Emanuel', 'Facundo'], ['Cucu', 'ricos'], ['Snif', 'fers']].map(p => p.join(''))
  for (const termo of proibidos) expect(await ui.find({ type: 'Text', text: new RegExp(termo, 'i') })).toBeFalsy()
  await ui.unmount()
})
