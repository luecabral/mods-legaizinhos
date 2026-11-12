// Preços em US$ por milhão de tokens. Claude: preço de lista da Anthropic.
// Gemini: página oficial (aistudio.google.com/docs/pricing), camada paga
// Standard, conferida em 11/11/2026. A primeira regra que casa com o id do
// modelo e ainda vale na data em que a execução começou vence. Modelo sem
// regra aparece no painel como "sem preço".
//
// Gemini: o pensamento conta como saída; o cache implícito não cobra escrita
// (cacheWrite 0) e o armazenamento de cache explícito, cobrado por hora, fica
// de fora. Nos Pro, vale a faixa de prompt até 200 mil tokens.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Meia-noite UTC do dia: as mudanças de preço do Google valem a partir dele. */
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const g = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: 0 })

export const PRICES: { match: RegExp; label: string; price: Price; until?: number }[] = [
  { match: /opus/i, label: 'Opus', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: /sonnet/i, label: 'Sonnet', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /haiku/i, label: 'Haiku', price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /fable/i, label: 'Fable', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },

  // Gemini 4: dobra em 01/12/2026.
  { match: /gemini-4-argon/i, label: 'Gemini 4 Argon', price: g(2, 10, 0.1), until: day('2026-12-01') },
  { match: /gemini-4-argon/i, label: 'Gemini 4 Argon', price: g(4, 20, 0.2) },
  { match: /gemini-4-carbon/i, label: 'Gemini 4 Carbon', price: g(2, 10, 0.1), until: day('2026-12-01') },
  { match: /gemini-4-carbon/i, label: 'Gemini 4 Carbon', price: g(4, 20, 0.2) },

  // Flash-Lite antes de Flash: o id do Lite também casa com "flash".
  { match: /gemini-3\.5-flash-lite/i, label: 'Gemini 3.5 Flash-Lite', price: g(0.3, 2.5, 0.03) },
  { match: /gemini-3\.1-flash-lite/i, label: 'Gemini 3.1 Flash-Lite', price: g(0.25, 1.5, 0.025) },
  { match: /gemini-2\.5-flash-lite/i, label: 'Gemini 2.5 Flash-Lite', price: g(0.1, 0.4, 0.01) },

  // 3.8 Flash: preço de lançamento até 31/12/2026, dobra em 01/01/2027.
  { match: /gemini-3\.8-flash/i, label: 'Gemini 3.8 Flash', price: g(0.75, 3.75, 0.075), until: day('2027-01-01') },
  { match: /gemini-3\.8-flash/i, label: 'Gemini 3.8 Flash', price: g(1.5, 7.5, 0.15) },
  { match: /gemini-3-flash/i, label: 'Gemini 3 Flash', price: g(0.5, 3, 0.05) },
  { match: /gemini-2\.5-flash/i, label: 'Gemini 2.5 Flash', price: g(0.3, 2.5, 0.03) },

  { match: /gemini-3(\.\d+)?-pro/i, label: 'Gemini 3.1 Pro', price: g(2, 12, 0.2) },
  { match: /gemini-2\.5-pro/i, label: 'Gemini 2.5 Pro', price: g(1.25, 10, 0.125) },

  // Ids que não estão acima: usa o modelo atual da mesma família (estimativa).
  { match: /gemini.*flash-lite/i, label: 'Gemini Flash-Lite', price: g(0.3, 2.5, 0.03) },
  { match: /gemini.*flash/i, label: 'Gemini Flash', price: g(0.75, 3.75, 0.075), until: day('2027-01-01') },
  { match: /gemini.*flash/i, label: 'Gemini Flash', price: g(1.5, 7.5, 0.15) },
  { match: /gemini.*pro/i, label: 'Gemini Pro', price: g(2, 12, 0.2) },
]

/** A regra do modelo que vale em `at` (ms); sem data, a mais recente. */
export const priceOf = (model: string, at = Infinity) => PRICES.find(p => p.match.test(model) && !(p.until !== undefined && at >= p.until))
