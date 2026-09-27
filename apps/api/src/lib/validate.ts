import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { ZodType } from 'zod'
import { ApiError } from './errors.ts'

/**
 * `zValidator` with one failure shape for every route, so a bad body reads the
 * same as any other error. Use this rather than `zValidator` directly.
 */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const first = result.error.issues[0]
      const where = first?.path.join('.')
      throw new ApiError(
        400,
        'invalid_request',
        where ? `${where}: ${first?.message}` : 'The request body is not valid.',
      )
    }
  })
}
