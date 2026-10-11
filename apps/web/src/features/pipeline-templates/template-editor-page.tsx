import { Fragment, useEffect, useState } from 'react'
import { Download, FileCode2, Info, Plus, Trash2 } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { FactsSkeleton, HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api-client.ts'
import { queryClient } from '@/lib/query-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { destination, slotName, templatesApi, type PipelineFile, type PipelineTemplate } from './api.ts'

/**
 * One template: its files, edited here and saved as a whole. "Import from the
 * reference" fills the editor from the reference application as it is now —
 * nothing is used until it is saved. Every save is kept, with who made it.
 */
export function TemplateEditorPage() {
  const [params] = useSearchParams()
  const dir = params.get('dir') ?? ''
  const template = useResource(['pipeline-templates', 'one', dir], () => templatesApi.get(dir))
  usePageTitle(template.data ? slotName(template.data.slot) : 'Pipeline template')

  if (template.error) {
    return (
      <div className={PAGE}>
        <PageHeader title="Pipeline template" description={template.error} />
      </div>
    )
  }
  if (!template.data) {
    return (
      <Loading className={PAGE}>
        <HeaderSkeleton />
        <FactsSkeleton />
        <RowsSkeleton rows={3} />
      </Loading>
    )
  }
  // Keyed by what was saved, so a save or a removal starts the editor again from it.
  return <Editor key={template.data.history[0]?.changedAt ?? 'new'} template={template.data} />
}

function Editor({ template }: { template: PipelineTemplate }) {
  const { slot } = template
  const [files, setFiles] = useState<PipelineFile[]>(template.files)
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState<'import' | 'save' | null>(null)
  const [removing, setRemoving] = useState(false)
  const dirty = JSON.stringify(files) !== JSON.stringify(template.files)

  // Leaving with unsaved changes loses them; the browser asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pipeline-templates'] })
  const failed = (error: unknown) => toast.error(error instanceof ApiError ? error.message : 'Something went wrong. Try again.')

  const importReference = async () => {
    setBusy('import')
    try {
      const imported = await templatesApi.importReference(slot.dir)
      setFiles(imported.files)
      setNotes(imported.notes)
      toast.success(`Read ${imported.files.length} file${imported.files.length === 1 ? '' : 's'} from ${slot.reference}. Check them, then save.`)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    try {
      await templatesApi.save(slot.dir, files)
      setNotes([])
      toast.success('Saved. Pipelines approved from now on are written from it.')
      await refresh()
    } catch (error) {
      failed(error)
    } finally {
      setBusy(null)
    }
  }

  const change = (index: number, patch: Partial<PipelineFile>) => setFiles((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)))

  return (
    <div className={PAGE}>
      <PageHeader
        title={slotName(slot)}
        description={
          <>
            <Link to="/pipeline-templates" className="underline-offset-4 hover:underline">
              Pipeline templates
            </Link>{' '}
            · {dirty ? 'Unsaved changes' : slot.saved ? `Saved by ${slot.saved.updatedByName}` : 'Not set — this target is not offered yet'}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={importReference} disabled={busy !== null}>
              {busy === 'import' ? <Spinner /> : <Download />}
              Import from the reference
            </Button>
            {slot.saved && (
              <Button variant="outline" onClick={() => setRemoving(true)} disabled={busy !== null}>
                <Trash2 />
                Remove
              </Button>
            )}
            <Button onClick={save} disabled={busy !== null || !dirty || files.length === 0}>
              {busy === 'save' && <Spinner />}
              Save
            </Button>
          </>
        }
      />

      <Split
        aside={
          <>
            <Section title="About this template">
              <Facts
                items={[
                  ['Written to', <Path text={destination(slot)} />],
                  [
                    'Reference',
                    <code>
                      <Path text={`${slot.repository}: ${slot.reference}`} />
                    </code>,
                  ],
                  [
                    'Placeholders',
                    slot.kind === 'project' ? (
                      <>
                        <code>__PROJECT__</code> becomes the project's name
                      </>
                    ) : slot.kind === 'manifests' ? (
                      <>
                        <code>__APPLICATION__</code> in paths becomes the application's name; contents are copied as they are
                      </>
                    ) : (
                      <>
                        <code>__APPLICATION__</code> becomes the application's name; the repository, version and fields are set by the technology
                      </>
                    ),
                  ],
                  ['Credentials', <>Never saved: write <code>changeme</code>, an Ansible expression or a vaulted value</>],
                ]}
              />
            </Section>
            <Section title="History">
              {template.history.length === 0 ? (
                <p className="text-sm text-muted-foreground">Never saved.</p>
              ) : (
                <ol className="space-y-2 text-sm">
                  {template.history.map((h, i) => (
                    <li key={`${h.changedAt}-${i}`} className="flex justify-between gap-3">
                      <span className="min-w-0">
                        {h.files === null ? 'Removed' : `Saved, ${h.files} file${h.files === 1 ? '' : 's'}`} by {h.changedByName}
                      </span>
                      <time className="shrink-0 text-muted-foreground" dateTime={h.changedAt}>
                        {new Date(h.changedAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        }
      >
        {notes.length > 0 && (
          <Section title="Check before saving">
            <ul className="space-y-1.5 text-sm">
              {notes.map((note) => (
                <li key={note} className="flex gap-2">
                  <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section
          title={`Files (${files.length})`}
          action={
            <Button variant="outline" size="sm" onClick={() => setFiles((current) => [...current, { path: '', content: '' }])}>
              <Plus />
              Add a file
            </Button>
          }
        >
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files. Import them from the reference, or add them one by one.</p>
          ) : (
            <div className="space-y-4">
              {files.map((file, index) => (
                <div key={index} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <Input
                      aria-label="Path"
                      value={file.path}
                      onChange={(event) => change(index, { path: event.target.value.trim() })}
                      placeholder="cicd.yml"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button variant="ghost" size="icon" aria-label={`Remove ${file.path || 'this file'}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>
                      <Trash2 />
                    </Button>
                  </div>
                  <Textarea
                    aria-label={`Contents of ${file.path || 'this file'}`}
                    value={file.content}
                    onChange={(event) => change(index, { content: event.target.value })}
                    rows={Math.min(24, Math.max(4, file.content.split('\n').length + 1))}
                    className="font-mono text-xs"
                    // YAML reads by its lines: scroll a long one rather than fold it into what looks like two.
                    wrap="off"
                    spellCheck={false}
                  />
                </div>
              ))}
            </div>
          )}
        </Section>
      </Split>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove this template?"
        confirm="Remove"
        destructive
        onConfirm={async () => {
          try {
            await templatesApi.remove(slot.dir)
            toast.success('Removed. It is kept in the history.')
            await refresh()
            return true
          } catch (error) {
            failed(error)
            return false
          }
        }}
      >
        <p>
          {slot.kind === 'project'
            ? 'Requests for projects new to inventories cannot be approved until it is saved again.'
            : `${slot.label} stops being offered for ${slot.target} until it is saved again.`}{' '}
          Requests already filed fail at approval.
        </p>
      </ConfirmDialog>
    </div>
  )
}

/** A path that wraps at its slashes, never inside a name. */
function Path({ text }: { text: string }) {
  const parts = text.split('/')
  return (
    <span className="break-normal">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  )
}
