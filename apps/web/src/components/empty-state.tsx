import type { ReactNode } from 'react'
import { SearchX, type LucideIcon } from 'lucide-react'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

/**
 * A page with nothing to show. Says what will fill it, or where to go, not
 * just that it is empty — built on shadcn's Empty so every empty screen in
 * the portal looks the same.
 *
 * The title stays the page's one h1: EmptyTitle renders a div, and the pages
 * that use this have no other heading.
 */
export function EmptyState({
  title,
  children,
  icon: Icon = SearchX,
  action,
}: {
  title: string
  children: ReactNode
  icon?: LucideIcon
  action?: ReactNode
}) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>
          <h1>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
