import { commandWords, programName } from '../shell.ts'
import type { Finding, ShellFacts } from './types.ts'

const INTERPRETERS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  python: ['-c'],
  python3: ['-c'],
  py: ['-c'],
  ruby: ['-e'],
  perl: ['-e'],
}
const WRITES_FILE = /(writeFileSync|writeFile\(|appendFileSync|createWriteStream|open\([^)]*['"][wa]\+?['"]|\.write_text\(|File\.write|fs\.write)/
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|json|md|mdx|css|scss|html|yml|yaml|toml|py|go|rs|java|kt|php|rb|sh|ps1|sql|txt)$/i

export function inlineScripts(shell: ShellFacts): Finding[] {
  const out: Finding[] = []
  const deny = (what: string) =>
    out.push({
      rule: 'edit.inline-script',
      message: `${what} edita archivos a ciegas. Usa las herramientas Edit/Write: el cambio queda visible y revisable.`,
    })

  for (const segment of shell.segments) {
    const words = commandWords(segment)
    const program = programName(words[0])
    const flags = INTERPRETERS[program]
    if (flags !== undefined && words.some(word => flags.includes(word)) && WRITES_FILE.test(segment.raw)) {
      deny(`Un script inline de \`${program}\` que escribe archivos`)
    }
    if ((program === 'sed' || program === 'perl') && words.some(word => /^-[a-z]*i/.test(word) || word === '--in-place')) {
      deny(`\`${program} -i\``)
    }
    if (['set-content', 'add-content', 'out-file', 'sc', 'ac'].includes(program)) {
      const target = words.slice(1).find(word => !word.startsWith('-'))
      if (target !== undefined && CODE_FILE.test(target)) deny(`\`${words[0]}\` sobre ${target}`)
    }
  }
  if (shell.dialect === 'powershell' && /get-content[^|]*\|[^|]*-replace[^|]*\|\s*(set-content|out-file)/i.test(shell.command)) {
    deny('Leer-reemplazar-escribir con Get-Content | -replace | Set-Content')
  }
  return out
}
