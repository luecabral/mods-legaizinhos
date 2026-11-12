export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Run = {
  id: string
  type: string
  description: string
  model: string
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  /** tokens somados por modelo que respondeu (Claude, Gemini via gateway, etc.) */
  byModel: Record<string, Tokens>
  added: number
  removed: number
  files: string[]
  /** true quando não é subagente do Claude, e sim um processo externo (Gemini CLI via script/gemini-dev) */
  external?: boolean
  /** código de saída do processo externo */
  exit?: number
  /** primeira linha do arquivo da tarefa, usada como título do card */
  title?: string
  /** leve ou pesado */
  effort?: string
  /** caminho (relativo ao projeto) do arquivo de eventos .jsonl do Gemini */
  flowPath?: string
  actions?: number
  lastAction?: string
  lastActionAt?: number
  /** última vez que o Gemini deu sinal (arquivo de eventos ou log mexido) */
  activityAt?: number
}

/** O que cada sessão publica no $.store para a sessão mãe ler. */
export type Figures = {
  /** custo pelo /cost da sessão (inclui os subagentes dela) */
  usd: number
  tokens: number
  added: number
  removed: number
  model?: string
  effort?: string
  /** HEAD do git agora e quando a sessão começou: dizem se ela fez commits */
  head?: string
  startHead?: string
  updatedAt: number
}

/** Uma sessão que esta começou (start_session), como o painel a mostra. */
export type Kid = {
  id: string
  title: string
  running: boolean
  archived: boolean
  /** true depois de desaninhada (movida para o topo) */
  detached: boolean
  model?: string
  effort?: string
  figures?: Figures
  /** os commits dela já estão no HEAD desta sessão */
  merged: boolean
}

/** Aninhada já mesclada: os números ficam guardados mesmo se ela for apagada. */
export type Merged = { id: string; title: string; usd: number; tokens: number }

/** Um comando de Gemini que esta sessão rodou: só as execuções que batem com ele aparecem no painel dela. */
export type Launch = {
  /** quando o comando começou e terminou (em segundo plano, termina logo) */
  at: number
  end?: number
  /** nome da tarefa, quando foi pelo script/gemini-dev */
  task?: string
}

declare module 'claude-code' {
  interface PluginState {
    subagentes: { runs: Shaped<Record<string, Run>>; merged: Shaped<Record<string, Merged>>; launches: Shaped<Launch[]> }
  }
}
