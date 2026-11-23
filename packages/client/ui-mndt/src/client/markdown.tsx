/**
 * A small Markdown reader for what agents write: enough for briefs and channel answers (headings,
 * GFM tables, lists, bold, inline code, fenced code blocks). React escapes every string: nothing in
 * the text becomes HTML.
 */
import type { ReactNode } from 'react'

/** @param text - inline markdown. @returns nodes with bold and code. */
export function inlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  parts.forEach((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) nodes.push(<strong key={index}>{part.slice(2, -2)}</strong>)
    else if (part.startsWith('`') && part.endsWith('`')) nodes.push(<code key={index}>{part.slice(1, -1)}</code>)
    else if (part !== '') nodes.push(part)
  })
  return nodes
}

/**
 * The Markdown an agent writes (a brief, an answer in a channel), as readable blocks: headings,
 * tables, lists, bold and code. Never raw markers; never HTML from the text.
 * @param markdown - the text.
 * @param options - `plainHeadings`: headings as bold paragraphs, never heading elements (a text
 * shown inside a page's own sections must not pass for one of them).
 * @returns the blocks.
 */
export function renderBrief(markdown: string, options: { readonly plainHeadings?: boolean } = {}): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = (): void => {
    if (list.length === 0) return
    blocks.push(<ul key={`ul-${blocks.length}`}>{list.map((item, index) => <li key={index}>{inlineNodes(item)}</li>)}</ul>)
    list = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim()
    // A fenced block (three or more backticks or tildes, a language or not): its lines as they are,
    // closed by a fence of the same mark at least as long, or by the end of the text when the
    // agent never closed it. Its markers are never shown.
    const fence = /^(`{3,}|~{3,})\s*([^`\s]*)/u.exec(trimmed)
    // As CommonMark: a backtick fence whose rest holds a backtick is inline code (« ```npm i``` »),
    // never the opening of a block that would turn the rest of the answer into code.
    const inline = fence !== null && (fence[1] ?? '').startsWith('`') && trimmed.slice((fence[1] ?? '').length).includes('`')
    if (fence !== null && !inline) {
      flush()
      const mark = fence[1] ?? '```'
      const language = fence[2] ?? ''
      const indent = /^\s*/u.exec(lines[index] ?? '')?.[0].length ?? 0
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const raw = lines[index] ?? ''
        const closing = raw.trim()
        if (closing.length >= mark.length && closing === (mark[0] ?? '`').repeat(closing.length)) break
        // A fence indented in a list keeps its lines relative to it.
        body.push(raw.slice(Math.min(indent, /^\s*/u.exec(raw)?.[0].length ?? 0)))
        index += 1
      }
      blocks.push(
        <pre key={`pre-${index}`} className="md-code">
          <code {...(language === '' ? {} : { 'data-lang': language })}>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flush()
      const level = heading[1]?.length ?? 1
      const content = inlineNodes(heading[2] ?? '')
      if (options.plainHeadings === true) blocks.push(<p key={`h-${index}`} className="md-heading"><strong>{content}</strong></p>)
      else blocks.push(level <= 2 ? <h3 key={`h-${index}`}>{content}</h3> : <h4 key={`h-${index}`}>{content}</h4>)
      continue
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flush()
      const rows: string[][] = []
      while (index < lines.length) {
        const row = (lines[index] ?? '').trim()
        if (!row.startsWith('|') || !row.endsWith('|')) break
        const cells = row.slice(1, -1).split('|').map(cell => cell.trim())
        if (!cells.every(cell => /^:?-{2,}:?$/.test(cell))) rows.push(cells)
        index += 1
      }
      index -= 1
      const [head, ...body] = rows
      if (head !== undefined) {
        blocks.push(
          <table key={`t-${index}`}>
            <thead><tr>{head.map((cell, cellIndex) => <th key={cellIndex}>{inlineNodes(cell)}</th>)}</tr></thead>
            <tbody>
              {body.map((cells, rowIndex) => (
                <tr key={rowIndex}>
                  {cells.map((cell, cellIndex) => <td key={cellIndex}>{inlineNodes(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>,
        )
      }
      continue
    }
    const item = /^[-*]\s+(.*)$/.exec(trimmed)
    if (item !== null) { list.push(item[1] ?? ''); continue }
    if (trimmed === '' || /^-{3,}$/.test(trimmed)) { flush(); continue }
    flush()
    blocks.push(<p key={`p-${index}`}>{inlineNodes(trimmed)}</p>)
  }
  flush()
  return blocks
}
