import type { LedgerTask } from '../types/index.d.ts'

// unlazy cuts the work; the native tasks we track come out of its PLAN.md. The plan's leaf
// dispatch table is its single authority for leaves, so that table is what is read.

export type PlanLeaf = {
  id: string
  name: string
  owns: string[]
  needs: string[]
  tier: string
  wave: string
  state: string
}

export type Plan = { title: string; leaves: PlanLeaf[] }

export type TaskSpec = {
  key: string
  subject: string
  description: string
  metadata: Record<string, unknown>
}

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

const list = (cell: string | undefined): string[] =>
  (cell ?? '').split(/\s*,\s*/).map(item => item.trim()).filter(item => item !== '' && item !== '-')

export function scopeOfPlanPath(path: string): string | undefined {
  return /(?:^|\/)\.unlazy\/([^/]+)\/PLAN\.md$/.exec(path.replaceAll('\\', '/'))?.[1]
}

export function parsePlan(text: string): Plan {
  // A plan written on Windows ends lines in \r\n, which the line-anchored patterns below do not cross.
  const withoutFences = text.replace(/\r\n?/g, '\n').replace(/```[\s\S]*?```/g, '')
  const title = /^#\s*Plan:\s*(.+)$/m.exec(withoutFences)?.[1]?.trim() ?? 'plan'
  const names = new Map<string, string>()
  for (const match of withoutFences.matchAll(/^\s*-\s+(\d+(?:\.\d+)*)\s+(.+?)\s+\S+\.md\s*$/gm)) {
    names.set(match[1]!, match[2]!.replace(/[\s.]+$/, '').trim())
  }

  const table = /##\s*Leaf dispatch table[\s\S]*?(\n\|[^\n]*\|[ \t]*\n\|[-:| ]+\|[ \t]*\n(?:\|[^\n]*\|[ \t]*\n?)*)/i.exec(withoutFences)?.[1]
  if (table === undefined) return { title, leaves: [] }
  const [header, , ...rows] = table.trim().split('\n')
  const columns = cells(header ?? '').map(column => column.toLowerCase())
  const at = (row: string[], name: string) => row[columns.indexOf(name)]
  const leaves: PlanLeaf[] = []
  for (const line of rows) {
    const row = cells(line)
    const id = at(row, 'leaf')?.replace(/^leaf-/, '')
    if (id === undefined || !/^[\d.]+$/.test(id)) continue
    leaves.push({
      id,
      name: names.get(id) ?? id,
      owns: list(at(row, 'owns')),
      needs: list(at(row, 'needs')),
      tier: at(row, 'tier') ?? '',
      wave: at(row, 'planned wave') ?? '',
      state: (at(row, 'state') ?? '').toUpperCase(),
    })
  }
  return { title, leaves }
}

export function leafLedger(scope: string, leaf: string): string {
  return `.unlazy/${scope}/gates/leaf-${leaf}.md`
}

export function reverifyCommand(skillDir: string, scope: string, leaf: string): string {
  return `node ${skillDir}/scripts/gate-check.mjs --root . --cwd . --reverify ${leafLedger(scope, leaf)}`
}

export function rootKey(scope: string): string {
  return `unlazy:${scope}`
}

export function leafKey(scope: string, leaf: string): string {
  return `unlazy:${scope}:${leaf}`
}

export function rootSpec(scope: string, plan: Plan): TaskSpec {
  return {
    key: rootKey(scope),
    subject: `unlazy ${scope}: ${plan.title}`,
    description: `Tarea madre del plan .unlazy/${scope}/PLAN.md. Se cierra cuando todas sus hojas están verificadas.`,
    metadata: { unlazy: scope, size: 'large', key: rootKey(scope) },
  }
}

export function leafSpecs(scope: string, plan: Plan, skillDir: string, parentId: string, existing: readonly LedgerTask[]): TaskSpec[] {
  const known = new Set(existing.map(task => task.key).filter((key): key is string => key !== undefined))
  return plan.leaves
    .filter(leaf => leaf.state !== 'ABANDONED' && !known.has(leafKey(scope, leaf.id)))
    .map(leaf => ({
      key: leafKey(scope, leaf.id),
      subject: `${leaf.id} ${leaf.name}`,
      description: [
        `Hoja ${leaf.id} del plan .unlazy/${scope}/PLAN.md, ledger ${leafLedger(scope, leaf.id)}.`,
        `Owns: ${leaf.owns.join(', ') || '-'} · Needs: ${leaf.needs.join(', ') || '-'} · Tier: ${leaf.tier || '-'} · Wave: ${leaf.wave || '-'}`,
      ].join('\n'),
      metadata: {
        parent: parentId,
        size: 'small',
        owns: leaf.owns,
        verify: reverifyCommand(skillDir, scope, leaf.id),
        unlazy: scope,
        leaf: leaf.id,
        key: leafKey(scope, leaf.id),
      },
    }))
}
