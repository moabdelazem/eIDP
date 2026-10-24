/**
 * A small stand-in for Elasticsearch, for tests and for trying `/elk` locally
 * without a cluster.
 *
 *   pnpm --filter @eidp/api elasticsearch:fake
 *   ELASTICSEARCH_URL=http://localhost:4050 ELASTICSEARCH_API_KEY=fake ELASTICSEARCH_INDICES=eidp-*
 *
 * It implements only what e-IDP calls — the root, a document by id, index
 * with and without an id, and search — with Elasticsearch's response and
 * error shapes. Search understands `match_all`, `term`, `terms`, `match`,
 * `query_string` (words, or `field:value`) and `bool` (`must`, `filter`,
 * `should`, `must_not`), `sort` on one field, and `size`/`from`: enough to
 * exercise the portal, not a search engine.
 */
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

type Doc = { id: string; version: number; source: Record<string, unknown> }

export function createFakeElasticsearch(options: { apiKey?: string } = {}) {
  const apiKey = options.apiKey ?? 'fake'
  const indices = new Map<string, Map<string, Doc>>()

  const error = (status: number, type: string, reason: string) => ({ error: { root_cause: [{ type, reason }], type, reason }, status })

  const app = new Hono()

  // Every call needs the key: an ApiKey header, or Basic elastic:<key>.
  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    const ok = auth === `ApiKey ${apiKey}` || auth === `Basic ${Buffer.from(`elastic:${apiKey}`).toString('base64')}`
    if (!ok) return c.json(error(401, 'security_exception', 'unable to authenticate user'), 401)
    await next()
  })

  app.get('/', (c) => c.json({ name: 'fake-node', cluster_name: 'eidp-fake', version: { number: '8.15.0' }, tagline: 'You Know, for Search' }))

  app.get('/:index/_doc/:id', (c) => {
    const { index, id } = c.req.param()
    const docs = indices.get(index)
    if (!docs) return c.json(error(404, 'index_not_found_exception', `no such index [${index}]`), 404)
    const doc = docs.get(id)
    if (!doc) return c.json({ _index: index, _id: id, found: false }, 404)
    return c.json({ _index: index, _id: id, _version: doc.version, found: true, _source: doc.source })
  })

  const write = (index: string, id: string, source: unknown) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return { status: 400 as const, body: error(400, 'mapper_parsing_exception', 'failed to parse') }
    const docs = indices.get(index) ?? new Map<string, Doc>()
    indices.set(index, docs)
    const before = docs.get(id)
    const doc = { id, version: (before?.version ?? 0) + 1, source: source as Record<string, unknown> }
    docs.set(id, doc)
    return { status: (before ? 200 : 201) as 200 | 201, body: { _index: index, _id: id, _version: doc.version, result: before ? 'updated' : 'created' } }
  }

  app.put('/:index/_doc/:id', async (c) => {
    const { status, body } = write(c.req.param('index'), c.req.param('id'), await c.req.json().catch(() => null))
    return c.json(body, status)
  })
  app.post('/:index/_doc', async (c) => {
    const { status, body } = write(c.req.param('index'), randomUUID().replaceAll('-', '').slice(0, 20), await c.req.json().catch(() => null))
    return c.json(body, status)
  })

  app.post('/:index/_search', async (c) => {
    const index = c.req.param('index')
    const docs = indices.get(index)
    if (!docs) return c.json(error(404, 'index_not_found_exception', `no such index [${index}]`), 404)
    const body = (await c.req.json().catch(() => ({}))) as { query?: Query; size?: number; from?: number; sort?: unknown[]; _source?: string[] }
    let matched = [...docs.values()].filter((doc) => matches(doc.source, body.query ?? { match_all: {} }))
    const sort = body.sort?.[0]
    if (sort) {
      const [field, dir] = typeof sort === 'string' ? [sort, 'asc'] : Object.entries(sort as Record<string, unknown>).map(([f, d]) => [f, typeof d === 'string' ? d : ((d as { order?: string })?.order ?? 'asc')])[0]!
      matched = matched.sort((a, b) => String(a.source[field as string] ?? '').localeCompare(String(b.source[field as string] ?? ''), undefined, { numeric: true }) * (dir === 'desc' ? -1 : 1))
    }
    const from = body.from ?? 0
    const page = matched.slice(from, from + (body.size ?? 10))
    return c.json({
      took: 1,
      timed_out: false,
      hits: {
        total: { value: matched.length, relation: 'eq' },
        max_score: page.length ? 1 : null,
        hits: page.map((doc) => ({
          _index: index,
          _id: doc.id,
          _score: 1,
          _source: body._source ? Object.fromEntries(Object.entries(doc.source).filter(([k]) => body._source!.includes(k))) : doc.source,
        })),
      },
    })
  })

  /** Seed a document directly, as if written earlier. */
  const put = (index: string, id: string, source: Record<string, unknown>) => write(index, id, source)

  return { app, put, indices }
}

type Query = Record<string, unknown>

/** The handful of query types the fake understands; anything else matches nothing. */
function matches(source: Record<string, unknown>, query: Query): boolean {
  const [type, spec] = Object.entries(query)[0] ?? ['match_all', {}]
  const text = (value: unknown) => String(value ?? '').toLowerCase()
  const fieldValue = (spec: unknown): [string, unknown] => {
    const [field, value] = Object.entries(spec as Record<string, unknown>)[0] ?? ['', undefined]
    return [field, value && typeof value === 'object' && !Array.isArray(value) ? ((value as { value?: unknown; query?: unknown }).value ?? (value as { query?: unknown }).query) : value]
  }
  switch (type) {
    case 'match_all':
      return true
    case 'term': {
      const [field, value] = fieldValue(spec)
      return source[field] === value
    }
    case 'terms': {
      const [field, values] = Object.entries(spec as Record<string, unknown[]>)[0] ?? ['', []]
      return (values as unknown[]).includes(source[field])
    }
    case 'match': {
      const [field, value] = fieldValue(spec)
      return text(value)
        .split(/\s+/)
        .some((word) => text(source[field]).includes(word))
    }
    case 'query_string': {
      const q = text((spec as { query?: unknown }).query)
      return q.split(/\s+/).filter(Boolean).every((term) => {
        const [field, value] = term.includes(':') ? term.split(':', 2) : [null, term]
        return field ? text(source[field]).includes(value!) : Object.values(source).some((v) => text(v).includes(value!))
      })
    }
    case 'bool': {
      const b = spec as { must?: Query[]; filter?: Query[]; should?: Query[]; must_not?: Query[] }
      const list = (v: Query[] | Query | undefined) => (v ? (Array.isArray(v) ? v : [v]) : [])
      return (
        list(b.must).every((q) => matches(source, q)) &&
        list(b.filter).every((q) => matches(source, q)) &&
        list(b.must_not).every((q) => !matches(source, q)) &&
        (list(b.should).length === 0 || list(b.should).some((q) => matches(source, q)))
      )
    }
    default:
      return false
  }
}

// Run on its own: `pnpm --filter @eidp/api elasticsearch:fake`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_ELASTICSEARCH_PORT ?? 4050)
  const fake = createFakeElasticsearch()
  fake.put('eidp-applications', 'agriland-api', { name: 'agriland-api', system: 'AgriLand', technology: 'DotNetCore', environment: 'prd' })
  fake.put('eidp-applications', 'nfp-backend', { name: 'nfp-backend', system: 'NBFS', technology: 'Spring', environment: 'dev' })
  serve({ fetch: fake.app.fetch, port })
  console.log(`Fake Elasticsearch on http://localhost:${port} — ELASTICSEARCH_API_KEY=fake, seeded index eidp-applications`)
}
