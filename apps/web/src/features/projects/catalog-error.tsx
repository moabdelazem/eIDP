import { Button } from '@/components/ui/button'
import { RefreshCatalogButton } from './refresh-catalog-button.tsx'

/**
 * Shown when the catalog cannot be loaded. Says what is wrong in the API's own
 * words and offers the one action that might fix it, rather than a dead end.
 */
export function CatalogUnavailable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="max-w-prose">
      <h1 className="text-lg font-semibold tracking-tight">Can’t reach the projects right now</h1>
      <p className="mt-2 text-muted-foreground">{error}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {/* For DevOps an empty map is one click from built, not a dead end. */}
        <RefreshCatalogButton variant="default" />
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}
