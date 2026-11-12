import { expect, test } from 'claude-code/testing'

import { isMerged, isNested, parseJson, rowsOf } from './sessions'
import type { Kid } from '../types'

const kid = (over: Partial<Kid> = {}): Kid => ({
  id: 'local_a',
  title: 'x',
  running: true,
  archived: false,
  detached: false,
  merged: false,
  ...over,
})

test('aninhada some quando desaninhada, arquivada ou mesclada', async () => {
  expect(isNested(kid())).toBe(true)
  expect(isNested(kid({ detached: true }))).toBe(false)
  expect(isNested(kid({ archived: true }))).toBe(false)
  expect(isNested(kid({ merged: true }))).toBe(false)
})

test('mesclada só quando fez commits e o HEAD dela está no histórico daqui', async () => {
  const f = { usd: 1, tokens: 1, added: 0, removed: 0, updatedAt: 0 }
  expect(isMerged({ ...f, head: 'b', startHead: 'a' }, true)).toBe(true)
  // sem commits novos o HEAD dela é ancestral daqui por tabela: não conta
  expect(isMerged({ ...f, head: 'a', startHead: 'a' }, true)).toBe(false)
  expect(isMerged({ ...f, head: 'b', startHead: 'a' }, false)).toBe(false)
  expect(isMerged(undefined, true)).toBe(false)
})

test('lê a lista do app em JSON e trata a frase de lista vazia', async () => {
  expect(rowsOf(parseJson('[{"sessionId":"local_a","startedBy":"local_me"}]'))).toEqual([
    { sessionId: 'local_a', startedBy: 'local_me' },
  ])
  expect(rowsOf(parseJson('No other sessions found.'))).toEqual([])
  expect(rowsOf(parseJson('{"sessions":[{"sessionId":"local_b"}]}'))).toEqual([{ sessionId: 'local_b' }])
})
