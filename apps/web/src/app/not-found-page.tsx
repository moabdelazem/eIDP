import { Link } from 'react-router'
import { EmptyState } from '@/components/empty-state.tsx'

export function NotFoundPage() {
  return (
    <EmptyState title="This page does not exist">
      Check the address, or go back to the <Link to="/" className="underline">project map</Link>.
    </EmptyState>
  )
}
