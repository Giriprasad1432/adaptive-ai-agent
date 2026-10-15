import React, { useState } from 'react'

function renderInline(text) {
  if (!text) return null
  // Regex to match inline code, bold, italic
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g)

  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="inline-code">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{renderInline(part.slice(2, -2))}</strong>
    }
    if (
      (part.startsWith('*') && part.endsWith('*') && part.length > 2) ||
      (part.startsWith('_') && part.endsWith('_') && part.length > 2)
    ) {
      return <em key={i}>{part.slice(1, -1)}</em>
    }
    return part
  })
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-header">
        <span className="code-lang">{lang || 'plaintext'}</span>
        <button
          type="button"
          className="copy-btn"
          onClick={handleCopy}
          aria-label="Copy code to clipboard"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function TableBlock({ rows }) {
  if (rows.length === 0) return null

  const parseRow = (row) => {
    return row
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
  }

  // Row 0 is header, Row 1 is separator (e.g. ---|---), Row 2+ are data
  const headers = parseRow(rows[0])
  const dataRows = rows.slice(2).map(parseRow)

  return (
    <div className="md-table-wrapper">
      <table className="md-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{renderInline(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((r, rowIndex) => (
            <tr key={rowIndex}>
              {r.map((cell, cellIndex) => (
                <td key={cellIndex}>{renderInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FormattedContent({ text }) {
  if (!text) return null

  const lines = text.split('\n')
  const elements = []
  let tableBuffer = []
  let inTable = false

  const flushTable = (key) => {
    if (tableBuffer.length > 0) {
      elements.push(<TableBlock key={`table-${key}`} rows={[...tableBuffer]} />)
      tableBuffer = []
    }
    inTable = false
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    // Table detection: line starts and ends with | or contains |
    const isTableLine = trimmed.startsWith('|') && trimmed.endsWith('|')

    if (isTableLine) {
      if (!inTable) {
        inTable = true
        tableBuffer = [trimmed]
      } else {
        tableBuffer.push(trimmed)
      }
      continue
    } else if (inTable) {
      flushTable(i)
    }

    // Headers
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="md-h3">
          {renderInline(trimmed.slice(4))}
        </h3>
      )
      continue
    }
    if (trimmed.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="md-h2">
          {renderInline(trimmed.slice(3))}
        </h2>
      )
      continue
    }
    if (trimmed.startsWith('# ')) {
      elements.push(
        <h1 key={i} className="md-h1">
          {renderInline(trimmed.slice(2))}
        </h1>
      )
      continue
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      elements.push(
        <blockquote key={i} className="md-blockquote">
          {renderInline(trimmed.slice(2))}
        </blockquote>
      )
      continue
    }

    // Unordered List
    if (trimmed.startsWith('• ') || trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      elements.push(
        <div key={i} className="md-list-item">
          <span className="bullet">✦</span>
          <span>{renderInline(trimmed.slice(2))}</span>
        </div>
      )
      continue
    }

    // Numbered List
    if (/^\d+\.\s/.test(trimmed)) {
      const match = trimmed.match(/^(\d+)\.\s(.*)$/)
      if (match) {
        elements.push(
          <div key={i} className="md-list-item">
            <span className="num-bullet">{match[1]}.</span>
            <span>{renderInline(match[2])}</span>
          </div>
        )
        continue
      }
    }

    // Horizontal Rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      elements.push(<hr key={i} className="md-hr" />)
      continue
    }

    // Empty space
    if (!trimmed) {
      elements.push(<div key={i} className="md-spacer" />)
      continue
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="md-p">
        {renderInline(rawLine)}
      </p>
    )
  }

  if (inTable) {
    flushTable('end')
  }

  return <>{elements}</>
}

export const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }) {
  if (!content) return null

  // Split on code blocks
  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className="markdown-content">
      {parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const firstLineEnd = part.indexOf('\n')
          const lang = firstLineEnd !== -1 ? part.slice(3, firstLineEnd).trim() : ''
          const code =
            firstLineEnd !== -1 ? part.slice(firstLineEnd + 1, -3) : part.slice(3, -3)

          return <CodeBlock key={index} lang={lang} code={code} />
        }

        return <FormattedContent key={index} text={part} />
      })}
    </div>
  )
})
