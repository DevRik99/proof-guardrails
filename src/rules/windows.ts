import { lines } from '../shell.ts'
import type { Finding, ShellFacts } from './types.ts'

// Both rules come from real failures: `--%` passed `; & $exe mcp get forge` to claude.exe as
// arguments, and a single-quoted JSON argument reached claude.ps1 with its quotes stripped.

const NATIVE = /^\s*(&\s*)?(["']?[\w.:\\/-]+\.exe["']?|claude|npx|npm|pnpm|yarn|node|gh|git|docker|code)\b/i

export function windowsShell(shell: ShellFacts): Finding[] {
  if (shell.dialect !== 'powershell') return []
  const out: Finding[] = []
  for (const line of lines(shell.command)) {
    const stop = line.indexOf('--%')
    if (stop !== -1) {
      const tail = line.slice(stop + 3)
      const swallowed = /(;|\|\||&&|\||\s\d?>&?\d?|\s2>&1)/.exec(tail)
      if (swallowed !== null) {
        out.push({
          rule: 'windows.stop-parsing',
          message:
            `\`--%\` pasa el resto de la línea literal al programa, incluido "${swallowed[1]!.trim()}" y lo que sigue. ` +
            'Pon cada comando posterior en su propia línea.',
        })
      }
      continue
    }
    if (NATIVE.test(line) && /'[^'\n]*"[^'\n]*'/.test(line)) {
      out.push({
        rule: 'windows.native-quotes',
        message:
          'Windows PowerShell 5.1 elimina las comillas dobles internas al pasar un argumento a un programa nativo ' +
          '(y los shims .ps1 como claude.ps1 también). Pasa el JSON por archivo, usa el .exe directo con `--%` ' +
          'en su propia línea, o escapa como \\".',
      })
    }
  }
  return out
}
