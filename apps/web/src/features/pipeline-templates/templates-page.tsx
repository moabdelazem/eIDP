import { CircleCheck, CircleDashed, FileCode2 } from 'lucide-react'
import { Link } from 'react-router'
import { PAGE, PageHeader, Section } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Badge } from '@/components/ui/badge'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { destination, templatesApi, type TemplateSlot } from './api.ts'

/**
 * Every template an approved pipeline is written from, and whether it is
 * there. A technology is on the request form for a deploy target only once
 * every template it needs for that target is saved — this page says which
 * are missing.
 */
export function PipelineTemplatesPage() {
  usePageTitle('Pipeline templates')
  const slots = useResource(['pipeline-templates'], templatesApi.list)

  return (
    <div className={`${PAGE} space-y-6`}>
      <PageHeader
        title="Pipeline templates"
        description={
          <>
            What approved pipeline requests write to inventories and ocp-templates. Import each from its reference application, check it, and save it; a technology is offered
            on the request form once every template it needs is saved. <code>__APPLICATION__</code> and <code>__PROJECT__</code> stand for the names the request gives.
          </>
        }
      />
      {slots.error && <p className="text-sm text-muted-foreground">{slots.error}</p>}
      {!slots.data && !slots.error && (
        <Loading>
          <RowsSkeleton rows={8} />
        </Loading>
      )}
      {slots.data && <Groups slots={slots.data} />}
    </div>
  )
}

function Groups({ slots }: { slots: TemplateSlot[] }) {
  const project = slots.filter((s) => s.kind === 'project')
  const technologies = [...new Set(slots.filter((s) => s.technology).map((s) => s.technology!))]
  return (
    <>
      <Section title="New project" description="Written once, when a request is for a project inventories does not have yet. Every technology needs it for new projects." flush>
        <Rows slots={project} />
      </Section>
      {technologies.map((key) => {
        const own = slots.filter((s) => s.technology === key)
        const targets = [...new Set(own.map((s) => s.target!))]
        const offered = targets.filter((t) => own.filter((s) => s.target === t).every((s) => s.saved))
        return (
          <Section
            key={key}
            title={own[0]!.label}
            description={
              offered.length ? `On the request form for ${offered.join(' and ')}.` : 'Not on the request form yet: a target is offered once all its templates are saved.'
            }
            action={
              <Badge variant="outline" className="shrink-0">
                {offered.length ? (
                  <>
                    <CircleCheck className="text-success" aria-hidden /> Offered
                  </>
                ) : (
                  <>
                    <CircleDashed className="text-muted-foreground" aria-hidden /> Not offered
                  </>
                )}
              </Badge>
            }
            flush
          >
            <Rows slots={own} />
          </Section>
        )
      })}
    </>
  )
}

function Rows({ slots }: { slots: TemplateSlot[] }) {
  return (
    <ul className="divide-y">
      {slots.map((slot) => (
        <li key={slot.dir}>
          <Link
            to={`/pipeline-templates/edit?dir=${encodeURIComponent(slot.dir)}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
          >
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                {slot.kind === 'project' ? 'group_vars/all' : slot.kind === 'manifests' ? 'Manifests' : 'group_vars'}
                {slot.target && ` · ${slot.target}`}
                {slot.appPath && ` (${slot.appPath})`}
              </span>
              <span className="block text-muted-foreground">{destination(slot)}</span>
            </span>
            {slot.saved ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <CircleCheck className="size-4 text-success" aria-hidden />
                Saved · {slot.saved.files} file{slot.saved.files === 1 ? '' : 's'} · {slot.saved.updatedByName}, {new Date(slot.saved.updatedAt).toLocaleDateString()}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <CircleDashed className="size-4" aria-hidden />
                Not set
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  )
}
