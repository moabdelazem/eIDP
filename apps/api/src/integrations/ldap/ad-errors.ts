/**
 * Active Directory reports every bind failure as LDAP error 49 and hides the
 * real reason in a sub-code: `... comment: AcceptSecurityContext error, data
 * 532, v3839`. Without reading it, an expired password and a locked account
 * both look like a typo, so people keep retrying and lock themselves out
 * further.
 */

export type BindFailure = {
  /** Safe to show the person signing in. */
  message: string
  /** Distinct code for the client; null means "treat as a normal rejection". */
  code: string | null
}

const REASONS: Record<string, BindFailure> = {
  '530': { code: 'logon_time_restricted', message: 'Your account is not allowed to sign in at this time of day.' },
  '531': { code: 'logon_workstation_restricted', message: 'Your account is not allowed to sign in from this machine.' },
  '532': { code: 'password_expired', message: 'Your password has expired. Change it, then sign in again.' },
  '533': { code: 'account_disabled', message: 'Your account is disabled. Ask IT to re-enable it.' },
  '701': { code: 'account_expired', message: 'Your account has expired. Ask IT to renew it.' },
  '773': { code: 'password_must_change', message: 'You must set a new password before signing in.' },
  '775': { code: 'account_locked', message: 'Your account is locked out. Wait for the lockout to clear, or ask IT to unlock it.' },
}

/**
 * `525` (no such user) and `52e` (wrong password) are deliberately absent:
 * telling an unauthenticated caller which of the two it was turns the login
 * form into an account-name oracle. Everything else here describes the state
 * of an account whose password was accepted as *correct or not yet checked*,
 * and is far more useful to the person than a generic refusal.
 */
export function readBindFailure(error: unknown): BindFailure | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /data ([0-9a-f]{3})/i.exec(message)
  if (!match) return null
  return REASONS[match[1]!.toLowerCase()] ?? null
}
