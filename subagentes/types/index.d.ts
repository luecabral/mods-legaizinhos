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

/** Uma tarefa em segundo plano desta sessão (Bash em segundo plano, Monitor). */
export type Bg = {
  id: string
  label: string
  at: number
  endedAt?: number
  /** comando do shell, para conferir no ps se ainda roda */
  command?: string
  /** última vez que o motor confirmou que rodava */
  seenAt?: number
  /** completed, failed, killed ou stopped */
  status?: string
}

/** O que a sessão principal está fazendo agora. */
export type Activity = {
  /** quando começou o turno em andamento; vazio quando ela espera você */
  turnAt?: number
  /** ferramenta que a principal está rodando agora */
  tool?: { label: string; at: number }
  bg: Record<string, Bg>
}

/** O PR aberto da branch da sessão, lido pelo gh. */
export type Pr = {
  number: number
  title: string
  url: string
  added: number
  removed: number
  draft: boolean
  /** OPEN, MERGED ou CLOSED */
  state: string
  failing: number
  pending: number
  /** checks que passaram (sucesso, neutro ou pulado) e o total */
  passed: number
  total: number
  /** branch do PR (headRefName) */
  branch?: string
  /** nome do repositório, como o app mostra antes do número */
  repo: string
  /** quando o painel viu o PR pela primeira vez */
  seenAt?: number
}

/** A branch atual, para o botão Criar PR. */
export type BranchInfo = {
  name: string
  /** sem PR, fora da branch padrão e com commits ou arquivos alterados */
  canCreate: boolean
  /** a branch já tem PR (aberto ou mergeado) */
  hasPr: boolean
  /** nome do repositório (origin) */
  repo: string
  /** linhas +/− da branch contra a base: commits, arquivos alterados e novos */
  added: number
  removed: number
}

declare module 'claude-code' {
  interface PluginState {
    subagentes: {
      runs: Shaped<Record<string, Run>>
      merged: Shaped<Record<string, Merged>>
      launches: Shaped<Launch[]>
      activity: Shaped<Activity>
      prs: Shaped<Record<string, Pr>>
      branch: Shaped<BranchInfo | null>
      /** URL do PR com o menu ⋯ aberto */
      menu: Shaped<string | null>
      /** o botão do fim do painel pediu controle remoto e computador acordado */
      away: Shaped<boolean>
    }
  }
}
