import { parseMarkdown, type Block, type Span } from '../../markdown.ts'
import { MONO } from './theme'

/**
 * Rendered markdown, drawn rather than injected.
 *
 * Lived inside the memory panel until the workflow dialog needed the same
 * thing: a workflow is a markdown document, and reading it as one is how you
 * check the briefs say what you meant. Two copies of a renderer is two places
 * for a heading to be styled differently, so it moved here instead.
 *
 * `parseMarkdown` produces data, never HTML - there is no sanitiser in this
 * path because there is no HTML in it.
 */
export function Markdown({
  text,
  style,
  innerRef,
  onScroll
}: {
  text: string
  /** Merged over the default page styling - callers embed this in panels. */
  style?: React.CSSProperties
  innerRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
}) {
  return (
    <div ref={innerRef} onScroll={onScroll} style={{ ...S.doc, ...style }}>
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'rule') return <hr style={S.hr} />
  if (block.kind === 'fence') {
    return (
      <pre style={S.fence}>
        {block.lang && <span style={S.lang}>{block.lang}</span>}
        {block.text}
      </pre>
    )
  }
  if (block.kind === 'heading') {
    const size = [17, 15, 13, 12, 12, 12][block.level - 1] ?? 12
    return (
      <div style={{ ...S.heading, fontSize: size, marginTop: block.level === 1 ? 4 : 16 }}>
        <Spans spans={block.spans} />
      </div>
    )
  }
  if (block.kind === 'quote') {
    return (
      <div style={S.quote}>
        <Spans spans={block.spans} />
      </div>
    )
  }
  if (block.kind === 'bullet') {
    return (
      <div style={{ ...S.bullet, marginLeft: 10 + block.depth * 16 }}>
        <span style={S.dot}>{block.ordered ? '·' : '•'}</span>
        <span>
          <Spans spans={block.spans} />
        </span>
      </div>
    )
  }
  return (
    <p style={S.para}>
      <Spans spans={block.spans} />
    </p>
  )
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === 'code')
          return (
            <code key={i} style={S.code}>
              {s.text}
            </code>
          )
        if (s.kind === 'strong')
          return (
            <b key={i} style={{ color: 'var(--ink)' }}>
              {s.text}
            </b>
          )
        if (s.kind === 'em') return <i key={i}>{s.text}</i>
        if (s.kind === 'link') {
          // Opened in the browser, not in the app: a link in a document is a
          // document to read, and a webview here would be a second browser.
          return (
            <a
              key={i}
              style={S.a}
              href={s.href}
              onClick={(e) => {
                e.preventDefault()
                window.bullpen.openExternal(s.href)
              }}
            >
              {s.text}
            </a>
          )
        }
        return <span key={i}>{s.text}</span>
      })}
    </>
  )
}

const S: Record<string, React.CSSProperties> = {
  // Rendered, so the container is a page rather than a code block: the pre-wrap
  // and monospace belong to the fences inside it.
  doc: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
    wordBreak: 'break-word',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: '12px 14px',
    margin: 0,
    font: `12px ${MONO}`,
    color: 'var(--ink)',
    lineHeight: 1.55
  },
  heading: { color: 'var(--ink)', fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' },
  para: { margin: '0 0 8px', color: 'var(--muted)', lineHeight: 1.6 },
  bullet: { display: 'flex', gap: 8, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 2 },
  dot: { color: 'var(--faint)' },
  quote: {
    borderLeft: '3px solid var(--line)',
    padding: '2px 0 2px 10px',
    margin: '0 0 8px',
    color: 'var(--faint)'
  },
  fence: {
    position: 'relative',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    padding: '10px 10px 8px',
    margin: '0 0 10px',
    overflowX: 'auto',
    whiteSpace: 'pre',
    color: 'var(--ink)',
    font: `11px ${MONO}`,
    lineHeight: 1.5
  },
  lang: {
    position: 'absolute',
    top: 2,
    right: 6,
    fontSize: 9,
    color: 'var(--faint)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase'
  },
  code: { background: 'var(--sunk)', padding: '1px 4px', color: 'var(--ink)' },
  a: { color: 'var(--accent-ink)', textDecoration: 'underline', cursor: 'pointer' },
  hr: { border: 0, borderTop: '1px solid var(--line)', margin: '12px 0' }
}
