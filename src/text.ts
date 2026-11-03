export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (let index = 0; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2)
    out.set(pair, (out.get(pair) ?? 0) + 1)
  }
  return out
}

/** Sørensen–Dice similarity over character bigrams of the normalized texts, 0..1. */
export function similarity(left: string, right: string): number {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const pairsA = bigrams(a)
  const pairsB = bigrams(b)
  let shared = 0
  for (const [pair, count] of pairsA) shared += Math.min(count, pairsB.get(pair) ?? 0)
  return (2 * shared) / (a.length - 1 + (b.length - 1))
}
