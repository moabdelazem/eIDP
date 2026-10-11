/**
 * Line-level YAML edits that leave the rest of a file exactly as it was —
 * comments, order, quoting — so the files written read like the ones beside
 * them. Ported from the old `new_applications.py`; a YAML parser round-trip
 * would reformat the whole file.
 */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Sets the first top-level `key:` line to `key: value`. With `append`, a key
 * that is not there is added at the end; otherwise the file is left as it is.
 */
export function setKey(content: string, key: string, value: string, { append = false } = {}): string {
  const line = new RegExp(`^${escape(key)}:.*$`, 'm')
  if (line.test(content)) return content.replace(line, () => `${key}: ${value}`)
  return append ? `${content.trimEnd()}\n${key}: ${value}\n` : content
}

/**
 * Sets `sub` inside the top-level block `top:` — the first `sub:` line indented
 * under it — keeping the value's double quotes if it had them. Nothing changes
 * when the block or the key is not there.
 */
export function setNested(content: string, top: string, sub: string, value: string): string {
  const topLine = new RegExp(`^${escape(top)}:\\s*$`)
  const subLine = new RegExp(`^(\\s+)${escape(sub)}:\\s*(.*)$`)
  const out: string[] = []
  let inBlock = false
  let replaced = false
  for (const line of content.split(/(?<=\n)/)) {
    const text = line.replace(/\n$/, '')
    if (!replaced && topLine.test(text)) {
      inBlock = true
      out.push(line)
      continue
    }
    if (inBlock && !replaced) {
      const match = subLine.exec(text)
      if (match) {
        const quote = match[2]!.trim().startsWith('"') ? '"' : ''
        out.push(`${match[1]}${sub}: ${quote}${value}${quote}\n`)
        replaced = true
        continue
      }
      if (text && !/^\s/.test(text)) inBlock = false
    }
    out.push(line)
  }
  return out.join('')
}
