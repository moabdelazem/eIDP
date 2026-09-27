import { Button } from '@/components/ui/button'

/**
 * Shown when the catalog cannot be loaded. Says what is wrong in the API's own
 * words and offers the one action that might fix it, rather than a dead end.
 */
export function CatalogUnavailable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="max-w-prose">
      <h1 className="text-lg font-semibold tracking-tight">Can’t reach the projects right now</h1>
      <p className="mt-2 text-muted-foreground">{error}</p>
      <Button variant="outline" className="mt-5" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
