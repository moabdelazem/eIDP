import { Link } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'

export function NotFoundPage() {
  usePageTitle('Not found')
  return (
    <EmptyState title="This page does not exist">
      Check the address, or go back to the <Link to="/" className="underline">projects map</Link>.
    </EmptyState>
  )
}
