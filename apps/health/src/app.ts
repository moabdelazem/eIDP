import { timingSafeEqual } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { Hono, type ValidationTargets } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z, type ZodType } from 'zod'
import { listAlerts } from './alerts.ts'
import { config } from './config.ts'
import { history } from './history.ts'
import { checkMachine } from './machines.ts'
import { lastRoundAt, machineSample, sampleOnce } from './sampler.ts'
import { addMachine, getMachine, listMachines, recordSamples, removeMachine, updateMachine, type MachineInput } from './store.ts'

/**
 * The health service's API. `/health` is its public liveness probe; all of
 * `/v1` takes the shared `HEALTH_TOKEN` as a bearer, because its only caller
 * is the portal, which does the permissions — DevOps never talk to this
 * directly. Writes name who asked in `x-eidp-actor`, which the portal sets
 * from the signed-in person; it is trusted because the token is.
 *
 * Every failure has the portal's shape, `{ error: { code, message } }`, so
 * the portal can pass it through as it is.
 */

const fail = (status: 400 | 401 | 404 | 409, code: string, message: string) => new HTTPException(status, { res: Response.json({ error: { code, message } }, { status }) })

function validate<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const first = result.error.issues[0]
      throw fail(400, 'invalid_request', first?.path.length ? `${first.path.join('.')}: ${first.message}` : (first?.message ?? 'Not valid.'))
    }
  })
}

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/, 'A hostname or an IP address.')
const url = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'An http or https URL.')

const MachineBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    host,
    ports: z.array(z.number().int().min(1).max(65535)).max(20).default([22]),
    httpUrl: url.nullable().default(null),
    exporterUrl: url.nullable().default(null),
    group: z.string().trim().min(1).max(60).default('Servers'),
    environment: z.string().trim().max(30).nullable().default(null),
    notify: z.array(z.string().trim().email()).max(20).default([]),
    notes: z.string().trim().max(500).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .refine((m) => m.ports.length > 0 || m.httpUrl || m.exporterUrl, { message: 'Give it at least one port, an HTTP URL or a node_exporter URL to check.', path: ['ports'] })

function authorised(header: string | undefined): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(config.HEALTH_TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const actor = (c: { req: { header: (name: string) => string | undefined } }) => c.req.header('x-eidp-actor')?.slice(0, 200) || 'unknown'

export function createApp() {
  return new Hono()
    .onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse()
      // A name already taken is the one database refusal a person can cause.
      if ((err as { code?: string }).code === '23505') return c.json({ error: { code: 'machine_exists', message: 'A machine by that name already exists.' } }, 409)
      console.error('health: unhandled', err)
      return c.json({ error: { code: 'internal', message: 'The health service failed to answer that.' } }, 500)
    })
    .get('/health', (c) => c.json({ ok: true, lastRound: lastRoundAt(), sampleMinutes: config.HEALTH_SAMPLE_MINUTES }))
    .use('/v1/*', async (c, next) => {
      if (!authorised(c.req.header('authorization'))) throw fail(401, 'unauthorised', 'The health service did not recognise the token.')
      await next()
    })
    .get('/v1/history', validate('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(90) })), async (c) => c.json(await history(c.req.valid('query').days)))
    .get('/v1/machines', async (c) => c.json(await listMachines()))
    .post('/v1/machines', validate('json', MachineBody), async (c) => c.json(await addMachine(c.req.valid('json') as MachineInput, actor(c)), 201))
    .put('/v1/machines/:id', validate('param', z.object({ id: z.string().uuid() })), validate('json', MachineBody), async (c) => {
      const machine = await updateMachine(c.req.valid('param').id, c.req.valid('json') as MachineInput, actor(c))
      if (!machine) throw fail(404, 'machine_not_found', 'There is no such machine.')
      return c.json(machine)
    })
    .delete('/v1/machines/:id', validate('param', z.object({ id: z.string().uuid() })), async (c) => {
      if (!(await removeMachine(c.req.valid('param').id, actor(c)))) throw fail(404, 'machine_not_found', 'There is no such machine.')
      return c.body(null, 204)
    })
    // Checked now, and recorded as a sample — "Check now" on the page, or right after adding one.
    .post('/v1/machines/:id/check', validate('param', z.object({ id: z.string().uuid() })), async (c) => {
      const machine = await getMachine(c.req.valid('param').id)
      if (!machine) throw fail(404, 'machine_not_found', 'There is no such machine.')
      const reading = await checkMachine(machine)
      await recordSamples(new Date(), [machineSample(machine, reading)])
      return c.json(reading)
    })
    .post('/v1/sample', async (c) => {
      const round = await sampleOnce()
      return c.json({ at: round.at, portal: round.portal, samples: round.samples.length, alerts: round.alerts })
    })
    .get('/v1/alerts', validate('query', z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) })), async (c) => c.json(await listAlerts(c.req.valid('query').limit)))
}
