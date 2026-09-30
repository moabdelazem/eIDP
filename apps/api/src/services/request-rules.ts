/**
 * What Azure DevOps and Jira will accept as a name, checked before a request
 * is filed — so a DEVOPS approver never approves something that was always
 * going to fail.
 *
 * From the ADO Server naming restrictions, and Jira's defaults.
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

/** Jira's default `jira.projectname.maxlength`. */
export const MAX_JIRA_NAME = 80

/** Null when a Jira project name is worth asking Jira about; otherwise why not. */
export function jiraNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Give the project a name.'
  if (trimmed !== name) return 'Names cannot start or end with a space.'
  if (trimmed.length < 2) return 'Names need at least two characters.'
  if (name.length > MAX_JIRA_NAME) return `Names can be at most ${MAX_JIRA_NAME} characters.`
  if (CONTROL.test(name)) return 'Names cannot contain control characters.'
  return null
}

/**
 * The shape every Jira key shares — it prefixes every issue, `PAY-123`. Only
 * the part no server configures differently: the length limit, the exact
 * pattern and the reserved words are the server's own, so `keyProblem` in the
 * Jira integration asks it.
 */
export function jiraKeyProblem(key: string): string | null {
  if (key === '') return 'Give the project a key.'
  if (!/^[A-Z]/.test(key)) return 'Keys start with an uppercase letter.'
  if (!/^[A-Z][A-Z0-9]*$/.test(key)) return 'Keys use uppercase letters and digits only, like PAY.'
  if (key.length < 2) return 'Keys need at least two characters.'
  return null
}
