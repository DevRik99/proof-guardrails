import type { Finding, WriteFacts } from './types.ts'

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro|py|go|rs|java|kt|swift|php|rb|cs|c|cc|cpp|h|hpp|dart|scss|css|sql|sh|ps1)$/i
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i

const SUPPRESSION =
  /(eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error(?!\s*[:-]?\s*\S{6,})|#\s*type:\s*ignore|#\s*noqa|#\s*pylint:\s*disable|\/\/\s*nolint|@SuppressWarnings|biome-ignore|oxlint-disable|stylelint-disable|prettier-ignore)/i
const RULE_OFF = /["']?[\w@/-]+["']?\s*:\s*(["']off["']|0)\s*[,}\]]?/

/** Lines of `after` that are new relative to `before` (multiset difference). */
export function addedLines(before: string | null | undefined, after: string): string[] {
  if (before === null || before === undefined) return after.split(/\r?\n/)
  const counts = new Map<string, number>()
  for (const line of before.split(/\r?\n/)) counts.set(line, (counts.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of after.split(/\r?\n/)) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else out.push(line)
  }
  return out
}

export function lintSuppression(write: WriteFacts): Finding[] {
  const isLintConfig = /(^|\/)(\.?eslint[^/]*|tsconfig[^/]*\.json|biome\.jsonc?|\.oxlintrc[^/]*|ruff\.toml|pyproject\.toml|\.pylintrc)$/i.test(write.path)
  const offending = write.added.filter(line => {
    if (/lint-ok:\s*\S{6,}/.test(line)) return false
    if (CODE.test(write.path) && SUPPRESSION.test(line)) return true
    return isLintConfig && RULE_OFF.test(line)
  })
  if (offending.length === 0) return []
  return [{
    rule: 'write.lint-suppression',
    message:
      `Silencia el linter/type-checker en vez de corregir el código:\n${offending.slice(0, 5).map(line => `  ${line.trim()}`).join('\n')}\n` +
      'Corrige la causa. Si de verdad es un falso positivo, documenta en la misma línea `lint-ok: <motivo>`.',
  }]
}

const VOSEO = /\b(vos|tenés|podés|querés|sabés|hacés|decís|sos|andá|vení|fijate|mirá|poné|hacé|decí|tené|probá|usá|agregá|corré|abrí|escribí|elegí|seguí|dale|che|laburo|boludo|piola|re\s+(bien|lindo))\b/i

export function neutralSpanish(write: WriteFacts): Finding[] {
  const isProse = PROSE.test(write.path)
  const candidates = write.added.filter(line => {
    if (/neutral-spanish:allow/.test(line)) return false
    if (isProse) return true
    return CODE.test(write.path) && /^\s*(\/\/|#|\*|<!--)|["'`][^"'`]{12,}["'`]/.test(line)
  })
  const hits = candidates.filter(line => VOSEO.test(line))
  if (hits.length === 0) return []
  return [{
    rule: 'write.neutral-spanish',
    message:
      `Español no neutro (voseo o léxico regional):\n${hits.slice(0, 5).map(line => `  ${line.trim()}`).join('\n')}\n` +
      'Usa español neutro. Si es una cita deliberada, marca la línea con `neutral-spanish:allow`.',
  }]
}

const TIMING = /\b(timeout|time_out|deadline|retr(y|ies)|backoff|delay|sleep|interval|ttl|max_?wait)\w*\b[^\n]*?\d/i

export function timingChange(write: WriteFacts): Finding[] {
  if (write.before === null || write.before === undefined) return []
  const removed = new Set(addedLines(write.after, write.before).filter(line => TIMING.test(line)))
  const changed = write.added.filter(line => TIMING.test(line))
  if (removed.size === 0 || changed.length === 0) return []
  return [{
    rule: 'write.timing-change',
    message:
      'Cambiaste un valor de timeout/reintentos/espera. Antes de tocar tiempos, debe haber evidencia del origen ' +
      '(medición, log, traza) que muestre que el tiempo es la causa y no el síntoma. Si no la tienes, consíguela primero.',
  }]
}

/** New comment lines in a code file: candidates for the narration check, judged by a model. */
// `#` comments only where the language has them: in JS/TS a `#` line is a private field or
// text inside a template literal, and treating it as a comment denied a markdown fixture.
const HASH_COMMENTS = /\.(py|sh|bash|zsh|rb|ps1|psm1|r|pl|toml|ya?ml|cmake|mk)$|(^|\/)(Makefile|Dockerfile)$/i
const SLASH_COMMENTS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro|go|rs|java|kt|swift|php|cs|c|cc|cpp|h|hpp|dart|scss|css)$/i

export function newComments(write: WriteFacts): string[] {
  if (!CODE.test(write.path)) return []
  const hash = HASH_COMMENTS.test(write.path)
  const slash = SLASH_COMMENTS.test(write.path)
  const isComment = (line: string) =>
    (slash && /^(\/\/|\/\*|\*(?!\/))/.test(line)) || (hash && /^#(?!!|\s*(region|endregion))/.test(line)) || (/\.sql$/i.test(write.path) && /^--/.test(line))
  return write.added
    .map(line => line.trim())
    .filter(isComment)
    .filter(line => !/(comment-ok:|TODO|FIXME|HACK|XXX|eslint|@ts-|prettier|biome|@param|@returns|@type|@deprecated|@see|@example|SPDX|#!\/|type:\s*ignore|noqa)/.test(line))
    .filter(line => line.replace(/^[/#*\s]+/, '').length > 3)
}

export function isCodeFile(path: string): boolean {
  return CODE.test(path)
}
