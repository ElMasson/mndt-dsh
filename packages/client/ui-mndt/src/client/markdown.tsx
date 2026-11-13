/**
 * A small Markdown reader for what agents write: enough for briefs and channel answers (headings,
 * GFM tables, lists, bold, inline code). React escapes every string: nothing in the text becomes HTML.
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
 * @returns the blocks.
 */
export function renderBrief(markdown: string): ReactNode[] {
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
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flush()
      const level = heading[1]?.length ?? 1
      const content = inlineNodes(heading[2] ?? '')
      blocks.push(level <= 2 ? <h3 key={`h-${index}`}>{content}</h3> : <h4 key={`h-${index}`}>{content}</h4>)
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
