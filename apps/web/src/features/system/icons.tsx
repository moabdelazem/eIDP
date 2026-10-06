import { Activity, Boxes, KeyRound, LayoutGrid, Server, Users } from 'lucide-react'
import { AzureDevOpsIcon, JenkinsIcon, JiraIcon, OllamaIcon, PostgresIcon, VaultIcon } from '@/components/brand-icons.tsx'

type MarkProps = { className?: string; tone?: 'brand' | 'current' }

/**
 * Each component by its own mark where it has one — the product colours are
 * how people recognise them — and a Lucide icon where it does not (the
 * directory, the portal's own jobs). Decorative: the name is beside it.
 */
const ICON: Record<string, (props: MarkProps) => React.ReactNode> = {
  postgres: (p) => <PostgresIcon {...p} />,
  directory: (p) => <Users className={p.className} />,
  vault: (p) => <VaultIcon {...p} />,
  ado: (p) => <AzureDevOpsIcon {...p} />,
  jira: (p) => <JiraIcon {...p} />,
  jenkins: (p) => <JenkinsIcon {...p} />,
  ollama: (p) => <OllamaIcon {...p} />,
  catalog: (p) => <Boxes className={p.className} />,
  'jenkins-history': (p) => <JenkinsIcon {...p} />,
  'jenkins-access': (p) => <KeyRound className={p.className} />,
  'health-service': (p) => <Activity className={p.className} />,
  portal: (p) => <LayoutGrid className={p.className} />,
}

/** A health component's mark, by its id. Decorative — the name is always beside it. Nothing for an unknown id. */
export function ComponentIcon({ id, className, tone }: { id: string } & MarkProps) {
  // Our machines are `machine:<id>`; they share one mark.
  const Mark = id.startsWith('machine:') ? (p: MarkProps) => <Server className={p.className} /> : ICON[id]
  return Mark ? (
    <span aria-hidden className="flex shrink-0">
      {Mark({ className, tone })}
    </span>
  ) : null
}
