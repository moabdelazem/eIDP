import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { errorFields, log } from './log.ts'

/** The one error shape the API returns, whatever threw. */
export type ErrorBody = { error: { code: string; message: string } }

/**
 * An expected failure with a stable `code` clients can branch on. Anything
 * else that escapes a handler is a bug and becomes a 500 with no detail.
 */
export class ApiError extends HTTPException {
  readonly code: string

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(status, { message })
    this.code = code
  }
}

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    return c.json<ErrorBody>({ error: { code: err.code, message: err.message } }, err.status)
  }
  if (err instanceof HTTPException) {
    return c.json<ErrorBody>(
      { error: { code: 'http_error', message: err.message } },
      err.status,
    )
  }

  // Unexpected: log it in full, tell the caller nothing about our internals.
  log.error('unhandled error', { ...errorFields(err, { stack: true }), method: c.req.method, path: c.req.path })
  return c.json<ErrorBody>(
    { error: { code: 'internal', message: 'Something went wrong on our side.' } },
    500,
  )
}
