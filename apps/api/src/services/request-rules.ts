/**
 * What Azure DevOps will accept as a repository or project name, checked
 * before a request is filed — so a DEVOPS approver never approves something
 * that was always going to fail.
 *
 * From the ADO Server naming restrictions.
 */

// Printable characters ADO refuses in either kind of name.
const FORBIDDEN = /[\\/:*?"'<>|;#${},+=[\]]/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\ud800-\udfff]/

const RESERVED = new Set(
  [
    'AUX', 'CON', 'NUL', 'PRN', 'SERVER', 'SignalR', 'DefaultCollection', 'Web', 'bin',
    'web.config', 'App_code', 'App_Browsers', 'App_Data', 'App_GlobalResources',
    'App_LocalResources', 'App_Themes', 'App_WebResources',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
  ].map((name) => name.toLowerCase()),
)

export const MAX_NAME = 64

/** Null when ADO would accept the name; otherwise why it would not. */
export function nameProblem(name: string, what: 'repository' | 'project'): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return `Give the ${what} a name.`
  if (trimmed !== name) return 'Names cannot start or end with a space.'
  if (name.length > MAX_NAME) return `Names can be at most ${MAX_NAME} characters.`
  if (CONTROL.test(name)) return 'Names cannot contain control characters.'
  const bad = FORBIDDEN.exec(name)
  if (bad) return `Names cannot contain “${bad[0]}”.`
  if (name.startsWith('_')) return 'Names cannot start with an underscore.'
  if (name.startsWith('.') || name.endsWith('.')) return 'Names cannot start or end with a period.'
  if (RESERVED.has(name.toLowerCase())) return `“${name}” is reserved by Azure DevOps.`
  return null
}
