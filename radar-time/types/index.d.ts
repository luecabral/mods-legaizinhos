export type PrStatus = 'rascunho' | 'em revisão' | 'no ar' | 'fechado'

export type LinearProject = { name: string; url: string }

export type Level = 'baixa' | 'média' | 'alta'

// Tamanho do PR e a leitura de complexidade (trabalho) e cuidado (risco se der errado).
export type PrSize = {
  additions: number
  deletions: number
  files: number
  testLines: number
  areas: string[]
  complexity?: Level
  care?: Level
  why?: string
}

export type PrItem = {
  key: string
  login: string
  dev: string
  repo: string
  number: number
  title: string
  url: string
  status: PrStatus
  createdAt: string
  closedAt?: string
  ticket?: string
  ticketUrl?: string
  project?: LinearProject
  plain?: string
  size?: PrSize
}

// Card do Linear em andamento (status do tipo "started": Implementando, Revisando, ...).
export type IssueItem = {
  id: string
  dev: string
  title: string
  url: string
  status: string
  startedAt?: string
  updatedAt?: string
  projectName?: string
  project?: LinearProject
}

// Cards de um projeto do Linear: feitos, em andamento e o total (sem os cancelados).
export type ProjectProgress = { done: number; doing: number; total: number }

export type Feed = {
  items: PrItem[]
  issues: IssueItem[]
  progress: Record<string, ProjectProgress>
  updatedAt?: number
  isLoading: boolean
  error?: string
  linearError?: string
  isLinearMissing?: boolean
  // Etapa da busca em andamento, para a barra de carregamento.
  loading?: { label: string; done: number; total: number }
  isGhMissing?: boolean
  // O que o gh respondeu quando a checagem falhou, pra saber o motivo real.
  ghDetail?: string
}

// PR novo de alguém do time, mostrado no topo do painel até a pessoa abrir ou dispensar.
export type Alert = { key: string; dev: string; what: string; url: string }

export type Range = 'semana' | 'passada'

export type View = {
  range: Range
  collapsed: string[]
  // Só um dev fica aberto por vez, pra árvore do painel não passar do limite do app.
  // undefined = abre o primeiro que tem algo; '' = todos fechados.
  openDev?: string
  // Grupos em que a pessoa pediu "ver mais" (sem isso, cada grupo mostra até GROUP_LIMIT itens).
  showAll?: string[]
}

// Time escolhido pela pessoa; isReady = já leu o que estava guardado.
export type Team = { id?: string; isReady: boolean; isChoosing: boolean }

// Uma pessoa do time. `linear` é o e-mail dela no Linear (pode ficar vazio); role 'pm' marca quem é PM.
export type Member = { login: string; name: string; linear: string; role?: 'pm' }
export type TeamDef = { id: string; name: string; members: Member[] }

// Configuração guardada no $.store: nada disso vive no código.
export type Config = {
  org: string
  // Workspace do Linear (o trecho de linear.app/<workspace>); vazio = só GitHub.
  workspace?: string
  // Termos do negócio (separados por vírgula) que marcam um PR como sensível pelo caminho dos arquivos.
  extraTerms?: string
  teams: TeamDef[]
}

// Montagem da configuração (primeira vez ou edição): passo atual e rascunhos.
export type Wizard = {
  isReady: boolean
  // Aberto = o painel mostra a configuração em vez do radar.
  isOpen: boolean
  step: 'org' | 'times'
  org: string
  workspace: string
  extraTerms: string
  teams: TeamDef[]
  // Membros da org que o GitHub devolveu (logins) e o filtro digitado.
  available: string[]
  filter: string
  isLoading: boolean
  error?: string
  // Time sendo montado: id (vazio = novo), nome e quem está marcado (login -> nome, e-mail do Linear, PM).
  draftId?: string
  draftName: string
  picked: Record<string, { name: string; linear: string; isPm: boolean }>
}

declare module 'claude-code' {
  interface PluginState {
    'radar-time': {
      team: Shaped<Team>
      feed: Shaped<Feed>
      view: Shaped<View>
      alerts: Shaped<Alert[]>
      config: Shaped<Config & { isReady: boolean }>
      wizard: Shaped<Wizard>
    }
  }
}
