import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Activity, Effect, PaneView } from '../types'
import { clock, countByEffect, countByRule, day, GATED, toolLabel } from '../src/activity.ts'

export const PANE = 'guardrails'
const HISTORY_KEY = 'history'
const SESSION_CAP = 300
const HISTORY_CAP = 500

const activityAtom = atom({ plugin: 'proof-guardrails', key: 'activity' } as const, [], { shape: 'activity-1' })
const historyAtom = atom({ plugin: 'proof-guardrails', key: 'history' } as const, [], { shape: 'history-1' })
const viewAtom = atom({ plugin: 'proof-guardrails', key: 'view' } as const, 'sesion')
const onlyGatedAtom = atom({ plugin: 'proof-guardrails', key: 'onlyGated' } as const, false)

const COLORS: Record<Effect, string> = {
  ok: 'success',
  aviso: 'warning',
  confirmado: 'permission',
  rechazado: 'error',
  bloqueado: 'error',
  reescrito: 'suggestion',
  error: 'inactive',
  retenido: 'warning',
}

function isActivity(value: unknown): value is Activity {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<Activity>
  return typeof item.id === 'string' && typeof item.at === 'number' && typeof item.tool === 'string' && typeof item.effect === 'string' && Array.isArray(item.rules)
}

export async function loadHistory($: EngineInterface): Promise<void> {
  const stored = await $.store.get(HISTORY_KEY).catch(() => undefined)
  const list = Array.isArray(stored) ? stored.filter(isActivity).slice(-HISTORY_CAP) : []
  await update($, historyAtom, () => list)
}

export async function recordActivity($: EngineInterface, entry: Activity): Promise<void> {
  await update($, activityAtom, list => [...list, entry].slice(-SESSION_CAP))
  if (!GATED.has(entry.effect)) return
  const history = await update($, historyAtom, list => [...list, entry].slice(-HISTORY_CAP))
  await $.store.set(HISTORY_KEY, history).catch(() => undefined)
}

export async function openPane($: EngineInterface): Promise<{ isPlaced: boolean; reason: string }> {
  const opened = await $.ui.open({ id: PANE, title: 'Guardrails' }).catch((error: unknown) => ({ isPlaced: false as const, reason: String(error) }))
  return opened.isPlaced ? { isPlaced: true, reason: '' } : { isPlaced: false, reason: opened.reason }
}

export async function sessionActivity($: EngineInterface): Promise<Activity[]> {
  return read($, activityAtom)
}

export async function savedHistory($: EngineInterface): Promise<Activity[]> {
  return read($, historyAtom)
}

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view: PaneView = await read($, viewAtom)
    const onlyGated = await read($, onlyGatedAtom)
    const room = Math.max(6, (e.viewport?.rows ?? 32) - 9)

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab-sesion" label="Sesión" variant={view === 'sesion' ? 'primary' : 'secondary'} onPress={() => update($, viewAtom, () => 'sesion')} />
        <Button key="tab-historial" label="Historial" variant={view === 'historial' ? 'primary' : 'secondary'} onPress={() => update($, viewAtom, () => 'historial')} />
        <Button key="filtro" label={onlyGated ? 'Ver todo' : 'Solo gates'} onPress={() => update($, onlyGatedAtom, value => !value)} />
      </Box>
    )

    const row = (item: Activity, withDay: boolean) => (
      <Box key={item.id} flexDirection="column">
        <Text wrap="truncate">
          <Text dimColor>{withDay ? `${day(item.at)} ` : ''}{clock(item.at)} </Text>
          <Text color={COLORS[item.effect]} bold={item.effect !== 'ok'}>{item.effect.padEnd(10)}</Text>
          <Text> {toolLabel(item.tool)}</Text>
          {withDay && item.project !== undefined ? <Text dimColor> · {item.project}</Text> : null}
        </Text>
        {item.target !== '' ? <Text dimColor wrap="truncate">  {item.target}</Text> : null}
        {item.rules.length > 0 ? <Text dimColor wrap="truncate">  {item.rules.join(', ')}{item.message !== '' ? ` — ${item.message}` : ''}</Text> : null}
      </Box>
    )

    if (view === 'historial') {
      const history = await read($, historyAtom)
      const top = countByRule(history).slice(0, 8)
      const recent = [...history].reverse().slice(0, Math.max(3, Math.floor((room - top.length - 2) / 3)))
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>{history.length} decisiones guardadas entre sesiones</Text>
          {top.length === 0 ? (
            <Text dimColor>Ningún gate ha actuado todavía.</Text>
          ) : (
            <Box flexDirection="column">
              <Text bold>Reglas que más actuaron</Text>
              {top.map(([rule, count]) => (
                <Text key={rule} wrap="truncate">
                  <Text color="warning">{String(count).padStart(4)}</Text> {rule}
                </Text>
              ))}
            </Box>
          )}
          <Box flexDirection="column">{recent.map(item => row(item, true))}</Box>
          {history.length > 0 ? <Button key="limpiar" label="Borrar historial" onPress={async () => {
            await update($, historyAtom, () => [])
            await $.store.set(HISTORY_KEY, []).catch(() => undefined)
          }} /> : null}
        </Box>
      )
    }

    const activity = await read($, activityAtom)
    const counts = countByEffect(activity)
    const shown = [...activity].reverse().filter(item => !onlyGated || GATED.has(item.effect)).slice(0, Math.max(3, Math.floor(room / 2)))
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Text wrap="truncate">
          <Text dimColor>{activity.length} llamadas · </Text>
          <Text color="error">{counts.bloqueado + counts.rechazado} bloqueadas</Text>
          <Text dimColor> · </Text>
          <Text color="permission">{counts.confirmado} confirmadas</Text>
          <Text dimColor> · </Text>
          <Text color="warning">{counts.aviso + counts.retenido} avisos</Text>
          <Text dimColor> · </Text>
          <Text color="suggestion">{counts.reescrito} reescritas</Text>
        </Text>
        {shown.length === 0 ? <Text dimColor>{onlyGated ? 'Ningún gate ha actuado en esta sesión.' : 'Sin llamadas todavía.'}</Text> : null}
        <Box flexDirection="column">{shown.map(item => row(item, false))}</Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
