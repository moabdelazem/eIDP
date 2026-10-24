import type { ElkDocument, ElkSearchResult, ElkStatus, ElkWriteResult } from '@eidp/contracts/elk'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { getDocument, indexDocument, MAX_SIZE, search, status } from '../../integrations/elasticsearch/index.ts'
import { ApiError } from '../../lib/errors.ts'
import { log } from '../../lib/log.ts'
import { validate } from '../../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../../middleware/auth.ts'

/**
 * Elasticsearch through the portal: read, search and add documents in the
 * indices ELASTICSEARCH_INDICES allows, as the portal's own Elasticsearch
 * account. Who may is `elk.read` and `elk.write`; which indices is the
 * allowlist, checked in the integration. Writes are logged — index, id and
 * who, never the document.
 */

/** A document id, as Elasticsearch takes one: at most 512 bytes. */
const id = z.string().min(1).refine((value) => Buffer.byteLength(value) <= 512, 'An id is at most 512 bytes.')
/** A JSON object — not an array, not a scalar. */
const object = z.record(z.string(), z.unknown())

const searchBody = z
  .object({
    query: object.optional(),
    q: z.string().max(2000).optional(),
    size: z.number().int().min(0).max(MAX_SIZE).optional(),
    from: z.number().int().min(0).optional(),
    sort: z.array(z.union([z.string(), object])).max(10).optional(),
    fields: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict()

const writeBody = z
  .object({
    id: id.optional(),
    document: object,
    waitForSearch: z.boolean().optional(),
  })
  .strict()

const tooLarge = (max: string) =>
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: `The body is over ${max}.` } }, 413) })

export const elkRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/', requirePermission('elk.read'), async (c) => c.json((await status()) satisfies ElkStatus))

  .get('/indices/:index/documents/:id', requirePermission('elk.read'), async (c) => {
    const { index, id } = c.req.param()
    const doc = await getDocument(index, id)
    if (!doc) throw new ApiError(404, 'document_not_found', `${index} has no document ${id}.`)
    return c.json(doc satisfies ElkDocument)
  })

  .post('/indices/:index/search', requirePermission('elk.read'), tooLarge('1 MB'), validate('json', searchBody), async (c) => {
    const result = await search(c.req.param('index'), c.req.valid('json'))
    return c.json(result satisfies ElkSearchResult)
  })

  .post('/indices/:index/documents', requirePermission('elk.write'), tooLarge('1 MB'), validate('json', writeBody), async (c) => {
    const index = c.req.param('index')
    const { id, document, waitForSearch } = c.req.valid('json')
    const result = await indexDocument(index, document, { id, waitForSearch })
    log.info('elk document written', { index: result.index, id: result.id, result: result.result })
    return c.json(result satisfies ElkWriteResult, result.result === 'created' ? 201 : 200)
  })
