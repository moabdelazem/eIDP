/**
 * Email over SMTP: who it is from, and sending one message. Modules do not
 * send directly — they queue through the notifications module, which sends,
 * retries and records each one (docs/integrations.md).
 */
export { mailConfig, mailConfigured, parseAddresses, send, type MailConfig, type OutgoingMail } from './client.ts'
