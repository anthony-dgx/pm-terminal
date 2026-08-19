import { useMemo } from 'react'
import { marked, type Token, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { docTitle, isMarkdownLang, useReview } from '../review.js'

marked.setOptions({ gfm: true, breaks: false })

function CodeBlock({ code, lang }: { code: string; lang?: string }): React.ReactElement {
  const html = useMemo(() => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value
      } catch {
        // fall through to plain
      }
    }
    return hljs.highlightAuto(code).value
  }, [code, lang])

  const lines = code.split('\n').length
  const openReview = useReview()
  // A fenced markdown block is the one place the app shows markdown as source.
  // That is what Claude emits when you ask it for a document, so it is the
  // main way into the reader.
  const reviewable = openReview && isMarkdownLang(lang) && code.trim().length > 0

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <span className="code-meta">
          {lines} {lines === 1 ? 'line' : 'lines'}
        </span>
        {reviewable && (
          <button className="code-review" onClick={() => openReview(docTitle(code), code)}>
            Review
          </button>
        )}
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

function TableBlock({ token }: { token: Tokens.Table }): React.ReactElement {
  const header = token.header.map((c) => c.text)
  const rows = token.rows.map((r) => r.map((c) => c.text))

  return (
    <div className="table-block">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {header.map((h, i) => (
                <th key={i} style={{ textAlign: token.align[i] ?? 'left' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} style={{ textAlign: token.align[ci] ?? 'left' }}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function renderToken(token: Token): React.ReactNode {
  if (token.type === 'code') {
    const t = token as Tokens.Code
    return <CodeBlock code={t.text} lang={t.lang} />
  }
  if (token.type === 'table') {
    return <TableBlock token={token as Tokens.Table} />
  }
  const html = marked.parse(token.raw, { async: false })
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * The top-level tokens a reader can hang a comment on.
 *
 * `space` tokens are dropped because they would render as empty blocks and
 * shift every index after them. The reader's stored block indices are indices
 * into this filtered list, so it has to be the same filter on both sides.
 */
export function anchorableTokens(source: string): Token[] {
  return marked.lexer(source).filter((t) => t.type !== 'space')
}

interface MarkdownProps {
  source: string
  /**
   * Emit one element per top-level token, each tagged with its index, so a
   * comment can be anchored to it. Only the reader wants this: the normal path
   * coalesces prose into shared chunks, which is cheaper and is what every
   * message in the transcript has always rendered as.
   */
  anchored?: boolean
}

/**
 * Renders markdown by walking top-level tokens rather than dumping one HTML
 * string, so code blocks and tables can carry their own copy controls.
 */
export function Markdown({ source, anchored }: MarkdownProps): React.ReactElement {
  const parts = useMemo(() => {
    if (anchored) {
      return anchorableTokens(source).map((token, i) => (
        <div className="md-block" data-block={i} key={`block-${i}`}>
          {renderToken(token)}
        </div>
      ))
    }

    const tokens = marked.lexer(source)
    const out: React.ReactNode[] = []
    let buffer: string[] = []

    const flush = (key: string): void => {
      if (!buffer.length) return
      const html = marked.parse(buffer.join(''), { async: false })
      out.push(<div key={key} className="md" dangerouslySetInnerHTML={{ __html: html }} />)
      buffer = []
    }

    tokens.forEach((token, i) => {
      if (token.type === 'code') {
        flush(`md-${i}`)
        const t = token as Tokens.Code
        out.push(<CodeBlock key={`code-${i}`} code={t.text} lang={t.lang} />)
      } else if (token.type === 'table') {
        flush(`md-${i}`)
        out.push(<TableBlock key={`table-${i}`} token={token as Tokens.Table} />)
      } else {
        buffer.push(token.raw)
      }
    })
    flush('md-tail')
    return out
  }, [source, anchored])

  return <>{parts}</>
}
