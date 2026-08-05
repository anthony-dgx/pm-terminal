import { useMemo } from 'react'
import { marked, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { CopyButton } from './Copy.js'

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

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <span className="code-meta">
          {lines} {lines === 1 ? 'line' : 'lines'}
        </span>
        {/* Copies the raw source, so no line numbers or wrap artifacts. */}
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

function stripInline(md: string): string {
  // Tables get pasted into Sheets and Docs, where markdown emphasis is noise.
  return md
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
}

function TableBlock({ token }: { token: Tokens.Table }): React.ReactElement {
  const header = token.header.map((c) => c.text)
  const rows = token.rows.map((r) => r.map((c) => c.text))

  const asTsv = (): string =>
    [header, ...rows].map((r) => r.map((c) => stripInline(c).replace(/\t/g, ' ')).join('\t')).join('\n')

  const asMarkdown = (): string => token.raw.trim()

  return (
    <div className="table-block">
      <div className="table-head">
        {/* TSV is what actually pastes cleanly into Sheets and Docs tables. */}
        <CopyButton text={asTsv} label="Copy as TSV" title="Paste into Sheets or Docs" />
        <CopyButton text={asMarkdown} label="Copy as Markdown" />
      </div>
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

/**
 * Renders markdown by walking top-level tokens rather than dumping one HTML
 * string, so code blocks and tables can carry their own copy controls.
 */
export function Markdown({ source }: { source: string }): React.ReactElement {
  const parts = useMemo(() => {
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
  }, [source])

  return <>{parts}</>
}
