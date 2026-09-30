import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * The shapes every page is built from, so a wide screen is used the same way
 * everywhere: one width cap, a main column with a side column beside it, and
 * facts as label/value rows in a card. Before this each page stopped at its
 * own max-width and left the right third of a desktop empty.
 */

/** The width every page shares — the Overview's, so nothing jumps between pages. */
export const PAGE = 'mx-auto w-full max-w-6xl'

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  /** The page's one h1; pass a node when the title needs more than text. */
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** Anything under the title, like a status badge row. */
  children?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {typeof title === 'string' ? <h1 className="text-lg font-semibold tracking-tight">{title}</h1> : title}
        {description && <p className="mt-1 text-muted-foreground">{description}</p>}
        {children}
      </div>
      {/* Not shrink-0: with three actions on a phone that ran them off the screen. The header wraps them under the title instead. */}
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/**
 * A main column and a side column. The side stacks under the main one below
 * `lg`, so a phone reads the main content first.
 */
export function Split({ aside, children, className = 'mt-8' }: { aside: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem] ${className}`}>
      <div className="min-w-0 space-y-6">{children}</div>
      <aside className="min-w-0 space-y-6">{aside}</aside>
    </div>
  )
}

/** A titled card; the building block of both columns. */
export function Section({
  title,
  description,
  action,
  children,
  flush = false,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  /** For lists that run edge to edge, with their own row dividers. */
  flush?: boolean
}) {
  return (
    <Card className={flush ? 'gap-0 overflow-hidden py-0' : 'gap-4'}>
      <CardHeader className={flush ? 'border-b py-4' : ''}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && <CardDescription className="mt-1.5">{description}</CardDescription>}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className={flush ? 'px-0' : ''}>{children}</CardContent>
    </Card>
  )
}

/** Label/value rows. A null value reads as `empty` in muted text rather than vanishing. */
export function Facts({
  items,
  empty = 'Not set',
}: {
  items: [label: string, value: React.ReactNode][]
  empty?: string
}) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value ?? <span className="text-muted-foreground">{empty}</span>}</dd>
        </div>
      ))}
    </dl>
  )
}
