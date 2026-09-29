import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSession } from '@/features/auth/session-context.tsx'

/**
 * Across the top of every page while an admin views the portal as someone
 * else. Red, because it is exactly what red is for: a state that must not be
 * forgotten — everything below is someone else's view, and nothing can be
 * changed from it.
 */
export function ViewingAsBanner() {
  const { session, returnToSelf } = useSession()
  if (!session?.actor) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-primary px-4 py-2 text-sm text-primary-foreground">
      <Eye className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        Viewing as <span className="font-semibold">{session.name}</span> ({session.uid}) — read-only. What you see is what
        they see.
      </p>
      <Button size="sm" variant="secondary" className="h-7" onClick={returnToSelf}>
        Return to {session.actor.name}
      </Button>
    </div>
  )
}
