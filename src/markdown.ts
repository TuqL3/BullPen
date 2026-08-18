/**
 * Just enough Markdown to read a CLAUDE.md.
 *
 * Not a library: what has to render here is what people actually write in a
 * memory file - headings, lists, fenced code, tables of nothing more complex
 * than a line each. A parser for that is eighty lines and no dependency, and
 * the alternative was a Markdown package plus a sanitiser to make its HTML safe
 * to inject. Nothing here produces HTML: it produces data the panel draws.
 */
export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'para'; spans: Span[] }
  | { kind: 'bullet'; spans: Span[]; depth: number; ordered: boolean }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'fence'; lang: string; text: string }
  | { kind: 'rule' }

const FENCE = /^\s*(```|~~~)\s*(\S*)/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []

  const flush = (): void => {
    if (!para.length) return
    out.push({ kind: 'para', spans: inline(para.join(' ').trim()) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      // Everything up to the closing fence is code, including things that look
      // like headings - which is most of why this is parsed rather than regexed
      // line by line at render time.
      const marker = fence[1]
      const body: string[] = []
      i++
      for (; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith(marker)) break
        body.push(lines[i])
      }
      out.push({ kind: 'fence', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }

    if (!line.trim()) {
      flush()
      continue
    }
    if (RULE.test(line)) {
      flush()
      out.push({ kind: 'rule' })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      out.push({ kind: 'heading', level: heading[1].length, spans: inline(heading[2].trim()) })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flush()
      out.push({
        kind: 'bullet',
        depth: Math.min(3, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)),
        ordered: /\d/.test(bullet[2]),
        spans: inline(bullet[3])
      })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      out.push({ kind: 'quote', spans: inline(quote[1]) })
      continue
    }
    para.push(line.trim())
  }
  flush()
  return out
}

/** Inline code first: `**` inside backticks is two asterisks, not emphasis. */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/

export function inline(text: string): Span[] {
  const out: Span[] = []
  let rest = text
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m || m.index === undefined) break
    if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) })
    const tok = m[0]
    if (tok.startsWith('`')) out.push({ kind: 'code', text: tok.slice(1, -1) })
    else if (tok.startsWith('**')) out.push({ kind: 'strong', text: tok.slice(2, -2) })
    else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](')
      out.push({ kind: 'link', text: tok.slice(1, cut), href: tok.slice(cut + 2, -1) })
    } else out.push({ kind: 'em', text: tok.slice(1, -1) })
    rest = rest.slice(m.index + tok.length)
  }
  if (rest) out.push({ kind: 'text', text: rest })
  return out
}
