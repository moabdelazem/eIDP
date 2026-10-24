/**
 * Mail the portal sends (docs/integrations.md): queue it here, and the
 * `mail-outbox` job sends it, retries it and keeps it. The content is the
 * sending module's; the look is `renderEmail`'s.
 */
export { devopsAddresses, enqueueMail, mailsAbout, portalLink, renderEmail, resendMail, type EmailContent } from './service.ts'
export { jobs } from './jobs.ts'
