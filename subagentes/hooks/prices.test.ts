import { expect, test } from 'claude-code/testing'

import { priceOf } from './prices'

const nov = Date.parse('2026-11-11T12:00:00Z')
const dec = Date.parse('2026-12-02T12:00:00Z')
const jan = Date.parse('2027-01-02T12:00:00Z')

test('Argon dobra em 01/12 pela data em que a execução começou', () => {
  expect(priceOf('gemini-4-argon', nov)?.price.input).toBe(2)
  expect(priceOf('gemini-4-argon', dec)?.price.input).toBe(4)
})
test('3.8 Flash dobra em 01/01/2027', () => {
  expect(priceOf('gemini-3.8-flash', dec)?.price.output).toBe(3.75)
  expect(priceOf('gemini-3.8-flash', jan)?.price.output).toBe(7.5)
})
test('Flash-Lite não cai na regra de Flash', () => {
  expect(priceOf('gemini-2.5-flash-lite', nov)?.label).toBe('Gemini 2.5 Flash-Lite')
  expect(priceOf('gemini-3.5-flash-lite', nov)?.label).toBe('Gemini 3.5 Flash-Lite')
})
test('Pro e famílias sem regra própria', () => {
  expect(priceOf('gemini-3.1-pro-preview', nov)?.price.input).toBe(2)
  expect(priceOf('gemini-2.5-pro', nov)?.price.input).toBe(1.25)
  expect(priceOf('gemini-9-flash', nov)?.label).toBe('Gemini Flash')
  expect(priceOf('modelo-qualquer', nov)).toBe(undefined)
})
