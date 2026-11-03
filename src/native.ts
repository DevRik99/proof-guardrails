import { modeOf, type Config } from './config.ts'

// The engine's own permission rules come first: they hold in every mode (bypassPermissions
// included), split compound commands, strip wrappers and check redirect targets. A user mod
// cannot inject settings where a security plugin sits above it, so `/gates permisos` writes
// them into a real settings file; tool.check covers the forms the docs say a rule cannot
// see (`git -C . push`, `/usr/bin/git`, `bash -c '…'`, MCP shell tools) either way.

const both = (...commands: string[]): string[] =>
  commands.flatMap(command => [`Bash(${command})`, `PowerShell(${command})`])

export const NATIVE_RULES: Record<string, readonly string[]> = {
  'irreversible.publish': both(
    'git push *', 'git push',
    'gh pr merge *', 'gh release create *', 'gh release delete *', 'gh repo delete *', 'gh repo create *',
    'npm publish *', 'npm publish', 'npm unpublish *', 'pnpm publish *', 'yarn publish *', 'bun publish *',
    'vercel --prod *', 'vercel deploy --prod *', 'firebase deploy *', 'supabase db push *', 'fly deploy *',
    'eas submit *', 'wrangler deploy *',
  ),
  'irreversible.destructive': [
    ...both(
      'git reset --hard *', 'git clean -f*', 'git clean --force *', 'git branch -D *', 'git stash drop *',
      'git stash clear', 'git checkout -- *', 'git commit --no-verify *', 'git commit -n *',
      'pkill *', 'killall *', 'taskkill *', 'docker system prune *', 'docker volume rm *', 'docker volume prune *',
      'mkfs *', 'diskpart *',
    ),
    'PowerShell(Stop-Process -Name *)',
    'PowerShell(Format-Volume *)',
    'PowerShell(Clear-Disk *)',
  ],
  'irreversible.protected-path': [
    'Edit(**/.env)', 'Edit(**/.env.local)', 'Edit(**/.env.*.local)', 'Edit(**/.env.production*)',
    'Edit(**/.env.development*)', 'Edit(**/.env.staging*)',
    'Edit(**/package-lock.json)', 'Edit(**/pnpm-lock.yaml)', 'Edit(**/yarn.lock)', 'Edit(**/bun.lock)',
    'Edit(**/bun.lockb)', 'Edit(**/composer.lock)', 'Edit(**/Cargo.lock)', 'Edit(**/poetry.lock)',
    'Edit(**/.ai/gates.json)', 'Edit(~/.ssh/**)',
  ],
}

export type NativePermissions = { ask: string[]; deny: string[] }

export function nativePermissions(config: Config): NativePermissions {
  const out: NativePermissions = { ask: [], deny: [] }
  for (const [rule, entries] of Object.entries(NATIVE_RULES)) {
    const mode = modeOf(config, rule)
    if (mode === 'ask') out.ask.push(...entries)
    if (mode === 'deny') out.deny.push(...entries)
  }
  return out
}

type Settings = Record<string, unknown> & {
  permissions?: { ask?: unknown; deny?: unknown } & Record<string, unknown>
  attribution?: unknown
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** The merged settings with this mod's permission rules and attribution policy added. */
export function withNative(settings: Settings, config: Config): Settings {
  const ours = nativePermissions(config)
  const permissions = settings.permissions ?? {}
  const merged: Settings = {
    ...settings,
    permissions: {
      ...permissions,
      ask: [...new Set([...list(permissions.ask), ...ours.ask])],
      deny: [...new Set([...list(permissions.deny), ...ours.deny])],
    },
  }
  if (modeOf(config, 'attribution.strip') !== 'off') merged.attribution = { commit: '', pr: '' }
  return merged
}

const PERMISSION = /^(Bash|PowerShell|Edit|Read|WebFetch|Agent|Skill|mcp__[\w-]+)(\(.+\))?$/

export function isNativeRule(rule: string): boolean {
  return PERMISSION.test(rule) && !(rule.startsWith('mcp__') && rule.includes('('))
}
