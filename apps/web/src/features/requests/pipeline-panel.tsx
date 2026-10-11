import { FileCode2, TriangleAlert } from 'lucide-react'
import { Facts, Section } from '@/components/page-layout.tsx'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, type PortalRequest } from './api.ts'

/**
 * A pipeline request's own part of its page: what was asked for — to
 * everyone who may see the request — and, to the people who may decide it,
 * the files approving would write, worked out from inventories as they are
 * now. The requester never sees the files: reading them is the approver's job.
 */
export function PipelinePanel({ request: r }: { request: PortalRequest }) {
  const spec = r.pipeline
  if (!spec) return null
  return (
    <Section title="Pipeline">
      <Facts
        empty="—"
        items={[
          ['Application', <code>{spec.application}</code>],
          ['Build technology', `${spec.technology}${spec.version ? ` ${spec.version}` : ''}${spec.library ? ', a library' : ''}`],
          ['Deploy target', spec.deployTarget === 'OCP' ? 'OpenShift' : 'Kubernetes'],
          ...Object.entries(spec.fields).map(([name, value]) => [name.replaceAll('_', ' '), <code>{value}</code>] as [string, React.ReactNode]),
          ['Project in inventories', spec.newProject ? 'New — its team.yml and namespaces are written too' : 'Already there; reused'],
        ]}
      />
      {r.canDecide && r.status !== 'completed' && r.status !== 'rejected' && r.status !== 'cancelled' && <Files requestId={r.id} />}
    </Section>
  )
}

function Files({ requestId }: { requestId: string }) {
  const preview = useResource(['requests', 'pipeline', 'preview', requestId], () => requestsApi.pipelinePreview(requestId))
  if (preview.loading) return <Skeleton className="mt-4 h-24 w-full" />
  if (preview.error) {
    return (
      <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <TriangleAlert className="size-4" aria-hidden /> Could not work out the files: {preview.error}
      </p>
    )
  }
  const { files, errors, commit } = preview.data!
  if (commit) return <p className="mt-4 text-sm text-muted-foreground">Already in inventories, in commit <code>{commit.slice(0, 10)}</code>.</p>
  return (
    <div className="mt-4 space-y-3">
      <h3 className="text-sm font-semibold">What approving writes to inventories</h3>
      {errors.length > 0 && (
        <ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Would fail: </span>
                {error}
              </span>
            </li>
          ))}
        </ul>
      )}
      {files.map((file) => (
        <details key={file.path} className="rounded-md border">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <code className="break-words">{file.path}</code>
          </summary>
          <pre className="overflow-x-auto border-t bg-muted/40 p-3 text-xs">{file.content}</pre>
        </details>
      ))}
    </div>
  )
}
