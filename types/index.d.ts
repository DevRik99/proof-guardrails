export type Ledger = {
  windowStart: number
  edits: { path: string; at: number }[]
  verifications: { command: string; at: number }[]
  research: string[]
  questions: { question: string; answer: string }[]
  delegations: { kind: string; prompt: string; at: number }[]
  forgeActive: boolean
  stopBlocks: number
  decisions: { rule: string; effect: string; message: string; at: number }[]
  tasks: LedgerTask[]
}

export type LedgerTask = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  size?: string
  parent?: string
  owns?: string[]
  verify?: string
  unlazy?: string
  leaf?: string
  key?: string
  startedAt?: number
  files?: string[]
  verifiedAt?: number
}

export type Effect = 'ok' | 'aviso' | 'confirmado' | 'rechazado' | 'bloqueado' | 'reescrito' | 'error' | 'retenido'

export type Activity = {
  id: string
  at: number
  tool: string
  target: string
  effect: Effect
  rules: string[]
  message: string
  project?: string
}

export type PaneView = 'sesion' | 'historial'

declare module 'claude-code' {
  interface PluginState {
    'proof-guardrails': {
      ledger: Shaped<Ledger>
      activity: Shaped<Activity[]>
      history: Shaped<Activity[]>
      view: PaneView
      onlyGated: boolean
      seen: string[]
    }
  }
}
