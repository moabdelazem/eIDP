import type { ElkDocument, ElkSearch, ElkSearchResult, ElkStatus, ElkWriteResult } from '@eidp/contracts/elk'
import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'
import { assertIndex, esConfig, esRequest, parseIndices, scriptIn } from './client.ts'

export { indexAllowed, indexNameProblem } from './client.ts'

/**
 * Elasticsearch — reading and writing documents in the indices the portal is
 * allowed (ELASTICSEARCH_INDICES). Every function checks the index first: a
 * valid name, on the list. Other modules call these; `modules/elk` puts them
 * behind the portal's API.
 */

/** The largest page of hits one search returns. */
export const MAX_SIZE = 100
/** The deepest a search may page (Elasticsearch's own `index.max_result_window` is 10,000). */
const MAX_WINDOW = 10_000

/** Whether Elasticsearch answers, and which indices the portal may use. Never throws. */
export async function status(): Promise<ElkStatus> {
  const indices = parseIndices(config.ELASTICSEARCH_INDICES)
  try {
    esConfig()
  } catch (err) {
    return { configured: false, cluster: null, error: err instanceof Error ? err.message : String(err), indices }
  }
  try {
    const info = await esRequest<{ cluster_name: string; version: { number: string } }>('GET', '/')
    return { configured: true, cluster: { name: info.cluster_name, version: info.version.number }, error: null, indices }
  } catch (err) {
    return { configured: true, cluster: null, error: err instanceof Error ? err.message : String(err), indices }
  }
}

/** One document by id, or null when the index has none with that id. */
export async function getDocument(index: string, id: string): Promise<ElkDocument | null> {
  assertIndex(index)
  try {
    const doc = await esRequest<{ _index: string; _id: string; _version?: number; found: boolean; _source?: Record<string, unknown> }>(
      'GET',
      `${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`,
    )
    if (!doc.found) return null
    return { index: doc._index, id: doc._id, version: doc._version ?? null, source: doc._source ?? {} }
  } catch (err) {
    // A missing document is a 404 with `found: false`; a missing index is a 404 too. Either way: no such document.
    if (err instanceof ApiError && err.code === 'elasticsearch_not_found') return null
    throw err
  }
}

/** Documents matching a query in one index, a page at a time. */
export async function search(index: string, input: ElkSearch): Promise<ElkSearchResult> {
  assertIndex(index)
  const scripted = scriptIn(input.query) ?? scriptIn(input.sort)
  if (scripted) throw new ApiError(400, 'script_not_allowed', `A search through the portal does not run scripts (\`${scripted}\`).`)
  const size = input.size ?? 10
  const from = input.from ?? 0
  if (size < 0 || size > MAX_SIZE) throw new ApiError(400, 'invalid_request', `size is between 0 and ${MAX_SIZE}.`)
  if (from < 0 || from + size > MAX_WINDOW) throw new ApiError(400, 'invalid_request', `from + size is at most ${MAX_WINDOW}; narrow the query instead of paging that deep.`)

  const query = input.query ?? (input.q?.trim() ? { query_string: { query: input.q.trim() } } : { match_all: {} })
  const body = {
    query,
    size,
    from,
    track_total_hits: true,
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.fields ? { _source: input.fields } : {}),
  }
  const res = await esRequest<{
    took: number
    hits: { total: { value: number; relation: 'eq' | 'gte' } | number; hits: { _id: string; _index: string; _score: number | null; _source?: Record<string, unknown> }[] }
  }>('POST', `${encodeURIComponent(index)}/_search`, body)
  const total = typeof res.hits.total === 'number' ? { value: res.hits.total, relation: 'eq' as const } : res.hits.total
  return {
    index,
    total,
    took: res.took,
    hits: res.hits.hits.map((hit) => ({ id: hit._id, index: hit._index, score: hit._score, source: hit._source ?? {} })),
  }
}

/**
 * Adds a document, or replaces the one with that id. `waitForSearch` waits
 * until it is searchable (Elasticsearch's `refresh=wait_for`) — for a write
 * that is read straight back; otherwise it shows up within the index's
 * refresh interval, a second by default.
 */
export async function indexDocument(index: string, document: Record<string, unknown>, options: { id?: string; waitForSearch?: boolean } = {}): Promise<ElkWriteResult> {
  assertIndex(index)
  const query: Record<string, string> = options.waitForSearch ? { refresh: 'wait_for' } : {}
  const res = options.id
    ? await esRequest<{ _index: string; _id: string; _version: number; result: string }>('PUT', `${encodeURIComponent(index)}/_doc/${encodeURIComponent(options.id)}`, document, query)
    : await esRequest<{ _index: string; _id: string; _version: number; result: string }>('POST', `${encodeURIComponent(index)}/_doc`, document, query)
  return { index: res._index, id: res._id, result: res.result === 'updated' ? 'updated' : 'created', version: res._version }
}
