import type { Adjustment, PipelineFile, RequestChanges, RequestRecord } from '@eidp/contracts/requests'
import { and, eq, sql } from 'drizzle-orm'
import { db, isUniqueViolation } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import type { Access } from '../access/index.ts'
import { check } from './check.ts'
import { assertCanDecide } from './deciding.ts'
import type { Actor, Target } from './model.ts'
import { credentialsIn } from './pipeline/credentials.ts'
import { previewPipeline } from './pipeline/write.ts'
import { assess } from './risk.ts'
import { editsOf, find, toRecord, withSteps } from './rows.ts'
import { requests } from './schema.ts'

/**
 * A decider changing a waiting request before approving it, instead of
 * rejecting it and asking the requester to file it again: a repository's or
 * project's names, a Jira project's name and key, a pipeline's application
 * name and version, and the files a pipeline writes.
 *
 * Each change is checked as a new request would be (`check`, the request
 * itself left out of the duplicate search), recorded with who made it and
 * what it was (`adjustments`, shown to the requester too), and the request is
 * assessed again. The old portal let approvers override names and the YAML
 * at approval with no trace of what was asked; here the asked-for value stays
 * on the record.
 *
 * Access requests change nothing: who gets access is the requester's to ask.
 */

type Field = keyof Omit<RequestChanges, 'files'>

const CHANGEABLE: Record<RequestRecord['kind'], (keyof RequestChanges)[]> = {
  create_repository: ['collection', 'project', 'repository'],
  create_project: ['collection', 'project'],
  create_jira_project: ['project', 'projectKey'],
  create_pipeline: ['application', 'version', 'files'],
  grant_access: [],
  revoke_access: [],
}

const LABEL: Record<Field, string> = {
  collection: 'Collection',
  project: 'Project',
  repository: 'Repository',
  projectKey: 'Project key',
  application: 'Application',
  version: 'Version',
}

/** The most a decider's edit of one file may be — the templates' own limit. */
const FILE_MAX = 256 * 1024

export async function adjust(id: string, changes: RequestChanges, actor: Actor, access: Access): Promise<RequestRecord> {
  await assertCanDecide(id, access)
  const request = await find(id)
  if (request.status !== 'pending') throw new ApiError(409, 'request_not_pending', 'Only a request still waiting for a decision can be changed.')

  const allowed = CHANGEABLE[request.kind] ?? []
  const offered = (Object.keys(changes) as (keyof RequestChanges)[]).filter((key) => changes[key] !== undefined)
  const refused = offered.filter((key) => !allowed.includes(key))
  if (refused.length) {
    throw new ApiError(
      400,
      'not_changeable',
      allowed.length
        ? `Only ${allowed.map((key) => (key === 'files' ? 'the files' : LABEL[key].toLowerCase())).join(', ')} can be changed on this request.`
        : 'Nothing on an access request is changed before approving: who gets access is the requester’s to ask. Reject it with a note instead.',
    )
  }
  if (changes.files !== undefined && (changes.application !== undefined || changes.version !== undefined)) {
    throw new ApiError(400, 'one_at_a_time', 'Change the application or version first, then edit the files it writes.')
  }

  const at = new Date().toISOString()
  const record = (field: string, label: string, from: string | null, to: string | null): Adjustment => ({ field, label, from, to, by: actor.uid, byName: actor.name, at })
  const adjustments: Adjustment[] = []
  const next = { collection: request.collection, project: request.project, repository: request.repository, projectKey: request.projectKey, pipeline: request.pipeline }

  for (const field of ['collection', 'project', 'repository', 'projectKey'] as const) {
    const value = changes[field]?.trim()
    if (value === undefined || value === (next[field] ?? '')) continue
    if (!value) throw new ApiError(400, 'invalid_request', `${LABEL[field]} cannot be empty.`)
    adjustments.push(record(field, LABEL[field], next[field], field === 'projectKey' ? value.toUpperCase() : value))
    next[field] = field === 'projectKey' ? value.toUpperCase() : value
  }
  if (next.pipeline) {
    for (const field of ['application', 'version'] as const) {
      const value = changes[field]?.trim()
      if (value === undefined || value === (next.pipeline[field] ?? '')) continue
      if (!value) throw new ApiError(400, 'invalid_request', `${LABEL[field]} cannot be empty.`)
      adjustments.push(record(field, LABEL[field], next.pipeline[field], value))
      next.pipeline = { ...next.pipeline, [field]: value }
    }
  }

  // A name changed is checked as a new request would be: ADO's and Jira's rules, what exists, who else asked.
  if (adjustments.length) {
    const verdict = await check(targetOf(request, next), id)
    if (!verdict.ok) throw new ApiError(409, 'adjustment_refused', verdict.reason)
  }

  let edits: PipelineFile[] | undefined
  if (changes.files !== undefined) {
    edits = await keptEdits(request, changes.files)
    const before = await editsOf(id)
    const key = (files: PipelineFile[]) => JSON.stringify(files.map((f) => [f.path, f.content]).sort())
    if (key(before) !== key(edits)) {
      const describe = (files: PipelineFile[]) => `${files.length} edited: ${files.map((f) => f.path).join(', ')}`
      adjustments.push(record('files', 'Files', before.length ? describe(before) : null, edits.length ? describe(edits) : 'as the templates write them'))
    }
  } else if (adjustments.some((a) => a.field === 'application')) {
    // Renamed: the edited files' paths are not written any more.
    const before = await editsOf(id)
    if (before.length) {
      edits = []
      adjustments.push(record('files', 'Files', `${before.length} edited`, 'as the templates write them — the application was renamed'))
    }
  }

  if (adjustments.length === 0) return (await withSteps([request]))[0]!

  let rows
  try {
    rows = await db
      .update(requests)
      .set({
        collection: next.collection,
        project: next.project!,
        repository: next.repository,
        projectKey: next.projectKey,
        pipeline: next.pipeline,
        ...(edits !== undefined ? { pipelineEdits: edits.length ? edits : null } : {}),
        adjustments: sql`${requests.adjustments} || ${JSON.stringify(adjustments)}::jsonb`,
      })
      .where(and(eq(requests.id, id), eq(requests.status, 'pending')))
      .returning()
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'adjustment_refused', 'Another request already waits for that.')
    throw err
  }
  if (!rows[0]) throw new ApiError(409, 'request_not_pending', 'Someone decided this request a moment ago.')
  const updated = toRecord(rows[0])
  // What an approver weighs follows what will be done.
  void assess(updated).catch(() => {})
  return updated
}

/** The request as it would be filed with the changes, for `check`. */
function targetOf(request: RequestRecord, next: Pick<RequestRecord, 'collection' | 'project' | 'repository' | 'projectKey' | 'pipeline'>): Target {
  switch (request.kind) {
    case 'create_repository':
      return { kind: 'create_repository', collection: next.collection!, project: next.project, repository: next.repository! }
    case 'create_project':
      return { kind: 'create_project', collection: next.collection!, project: next.project, description: request.description ?? undefined }
    case 'create_jira_project':
      return { kind: 'create_jira_project', project: next.project, projectKey: next.projectKey!, description: request.description ?? undefined }
    case 'create_pipeline':
      return { kind: 'create_pipeline', collection: next.collection!, project: next.project, repository: next.repository!, pipeline: next.pipeline! }
    default:
      throw new ApiError(400, 'not_changeable', 'This request cannot be changed.')
  }
}

/**
 * The edits worth keeping: only files approving writes (no new paths), only
 * where they differ from what the templates write, and never a credential —
 * the same rule the templates are held to.
 */
async function keptEdits(request: RequestRecord, files: PipelineFile[]): Promise<PipelineFile[]> {
  const generated = await previewPipeline(request, [])
  if (generated.commit) throw new ApiError(409, 'already_written', 'These files are already in inventories.')
  const written = new Map([...generated.files, ...generated.manifests].map((f) => [f.path, f.content]))
  const kept: PipelineFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.path)) throw new ApiError(400, 'invalid_request', `${file.path} is edited twice.`)
    seen.add(file.path)
    if (!written.has(file.path)) throw new ApiError(400, 'invalid_request', `Approving does not write ${file.path}; only the files it writes can be edited.`)
    if (Buffer.byteLength(file.content) > FILE_MAX) throw new ApiError(400, 'invalid_request', `${file.path} is over ${FILE_MAX / 1024} KB.`)
    const credentials = credentialsIn(file.content)
    if (credentials.length) {
      throw new ApiError(400, 'credential_in_file', `${file.path} would carry a value for ${credentials.join(', ')}. A credential is never written from the portal; leave the placeholder and set it from the vault.`)
    }
    if (written.get(file.path) !== file.content) kept.push(file)
  }
  return kept
}
