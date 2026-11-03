import type { Activity, Effect } from '../types/index.d.ts'
import type { Verdict } from './evaluate.ts'

export type { Activity, Effect }

export const GATED: ReadonlySet<Effect> = new Set(['aviso', 'confirmado', 'rechazado', 'bloqueado', 'reescrito', 'retenido'])

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function toolLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__').slice(1)
  const action = parts.pop() ?? tool
  const server = parts.pop()
  return server === undefined ? action : `${action} · ${server}`
}

export function targetOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const command = str(input.command) ?? str(input.cmd)
  if (command !== undefined) return oneLine(command.split('\n')[0] ?? command, 140)
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
  if (path !== undefined) return oneLine(path, 140)
  if (tool === 'Agent' || tool === 'Task') {
    return oneLine(`${str(input.subagent_type) ?? 'general-purpose'}: ${str(input.description) ?? ''}`, 140)
  }
  const other = str(input.query) ?? str(input.url) ?? str(input.subject) ?? str(input.pattern) ?? str(input.prompt)
  return other === undefined ? '' : oneLine(other, 140)
}

type Ran = { deny?: string; isError?: boolean; text?: string }

const PERMISSION_DENIED = /permission to use \S+ (has been )?denied/i

export function outcome(ran: Ran, verdict: Verdict, rewrittenBy: string | undefined): Pick<Activity, 'effect' | 'rules' | 'message'> {
  const first = (items: readonly { rule: string; message: string }[]) => ({
    rules: items.map(item => item.rule),
    message: oneLine(items[0]?.message ?? '', 200),
  })
  const refusal = ran.deny ?? (ran.isError === true && PERMISSION_DENIED.test(ran.text ?? '') ? ran.text : undefined)
  if (refusal !== undefined) {
    if (verdict.deny.length > 0) return { effect: 'bloqueado', ...first(verdict.deny) }
    if (verdict.ask.length > 0) return { effect: 'rechazado', ...first(verdict.ask) }
    return { effect: 'bloqueado', rules: ['motor'], message: oneLine(refusal, 200) }
  }
  if (rewrittenBy !== undefined) return { effect: 'reescrito', rules: [rewrittenBy], message: 'trailer de atribución quitado del commit' }
  if (verdict.ask.length > 0) return { effect: 'confirmado', ...first(verdict.ask) }
  if (verdict.warn.length > 0) return { effect: 'aviso', ...first(verdict.warn) }
  if (ran.isError === true) return { effect: 'error', rules: [], message: '' }
  return { effect: 'ok', rules: [], message: '' }
}

export function countByEffect(list: readonly Activity[]): Record<Effect, number> {
  const counts: Record<Effect, number> = { ok: 0, aviso: 0, confirmado: 0, rechazado: 0, bloqueado: 0, reescrito: 0, error: 0, retenido: 0 }
  for (const item of list) counts[item.effect] += 1
  return counts
}

export function countByRule(list: readonly Activity[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const item of list) for (const rule of item.rules) counts.set(rule, (counts.get(rule) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const pad = (value: number) => String(value).padStart(2, '0')

export function clock(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function day(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function entryLines(item: Activity, withDay: boolean): string[] {
  const when = `${withDay ? `${day(item.at)} ` : ''}${clock(item.at)}`
  const where = withDay && item.project !== undefined ? ` · ${item.project}` : ''
  const lines = [`${when}  ${item.effect.toUpperCase().padEnd(10)} ${toolLabel(item.tool)}${where}`]
  if (item.target !== '') lines.push(`    ${item.target}`)
  if (item.rules.length > 0) lines.push(`    ${item.rules.join(', ')}${item.message !== '' ? ` — ${item.message}` : ''}`)
  return lines
}

export function activityText(list: readonly Activity[], onlyGated: boolean, limit = 25): string {
  const counts = countByEffect(list)
  const shown = [...list].reverse().filter(item => !onlyGated || GATED.has(item.effect)).slice(0, limit)
  return [
    `Sesión: ${list.length} llamadas · ${counts.bloqueado + counts.rechazado} bloqueadas · ${counts.confirmado} confirmadas · ` +
      `${counts.aviso + counts.retenido} avisos · ${counts.reescrito} reescritas`,
    ...(shown.length === 0 ? [onlyGated ? 'Ningún gate ha actuado en esta sesión.' : 'Sin llamadas todavía.'] : shown.flatMap(item => entryLines(item, false))),
  ].join('\n')
}

export function historyText(history: readonly Activity[], limit = 25): string {
  const top = countByRule(history).slice(0, 8)
  return [
    `Historial: ${history.length} decisiones guardadas entre sesiones`,
    ...(top.length === 0 ? ['Ningún gate ha actuado todavía.'] : ['Reglas que más actuaron:', ...top.map(([rule, count]) => `  ${String(count).padStart(4)}  ${rule}`)]),
    ...(history.length === 0 ? [] : ['Recientes:', ...[...history].reverse().slice(0, limit).flatMap(item => entryLines(item, true))]),
  ].join('\n')
}

export function projectName(cwd: string): string {
  return cwd.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || cwd
}
