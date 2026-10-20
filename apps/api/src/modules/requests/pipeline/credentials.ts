import { isSecretKey } from '../../../integrations/inventories/parse.ts'
import { PLACEHOLDER } from './generate.ts'

/**
 * The keys in a YAML file that look like credentials and hold a literal value.
 * The old generator copied a live application's files, and with them whatever
 * password or token sat in plaintext there — into a second application, under
 * a second team. A template-only placeholder, an Ansible expression or a
 * vaulted value is fine; anything else stops the write. Names only, never values.
 */
export function credentialsIn(content: string): string[] {
  const found: string[] = []
  for (const line of content.split('\n')) {
    const match = /^\s*(?:-\s+)?([\w.-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (!match || !isSecretKey(match[1]!)) continue
    const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
    if (value === '' || value === '~' || value === 'null' || value === PLACEHOLDER || value.startsWith('!vault') || /^\{\{.*\}\}$/.test(value)) continue
    found.push(match[1]!)
  }
  return [...new Set(found)]
}
