/** Elasticsearch through the portal: what `/elk` sends and takes (apps/api modules/elk). */

/** `GET /elk`: whether Elasticsearch is reachable, and which indices the portal may use. */
export type ElkStatus = {
  configured: boolean
  /** The cluster's name and version, when it answered. */
  cluster: { name: string; version: string } | null
  /** Why it could not be reached or is not set up, when it could not. */
  error: string | null
  /** ELASTICSEARCH_INDICES as configured: names, or patterns with `*`. */
  indices: string[]
}

/** One document, as stored. */
export type ElkDocument = {
  index: string
  id: string
  /** Elasticsearch's version of it: each write adds one. */
  version: number | null
  source: Record<string, unknown>
}

/** `POST /elk/indices/:index/search` takes this. */
export type ElkSearch = {
  /** Query DSL, as Elasticsearch takes it. Scripts are refused. */
  query?: Record<string, unknown>
  /** Or a simple search string (Lucene `query_string` syntax), when `query` is not given. */
  q?: string
  /** At most 100. */
  size?: number
  from?: number
  sort?: unknown[]
  /** Which fields of each document to return; all when not given. */
  fields?: string[]
}

export type ElkSearchResult = {
  index: string
  /** How many match in all — not only those returned. `relation: 'gte'` when Elasticsearch stopped counting. */
  total: { value: number; relation: 'eq' | 'gte' }
  took: number
  hits: { id: string; index: string; score: number | null; source: Record<string, unknown> }[]
}

/** `POST /elk/indices/:index/documents` takes this. */
export type ElkWrite = {
  /** Elasticsearch makes one when not given; given, the document with that id is replaced. */
  id?: string
  document: Record<string, unknown>
  /** Wait until the document is searchable before answering. Slower; for a write read straight back. */
  waitForSearch?: boolean
}

export type ElkWriteResult = {
  index: string
  id: string
  /** `created` for a new document, `updated` when one with that id was replaced. */
  result: 'created' | 'updated'
  version: number
}
