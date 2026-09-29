import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { syncCatalog } from './api.ts'
import { useCatalog } from './catalog-context.tsx'

/**
 * Pulls inventories now instead of waiting for the next scheduled sync, then
 * reloads the map. Shown only to people with `catalog.sync`; the API checks
 * again. A sync already running is joined server-side, so a second click (or
 * the timer) cannot start another.
 */
export function RefreshCatalogButton({ variant = 'outline' }: { variant?: 'outline' | 'default' }) {
  const { can } = useProfile()
  const { reload } = useCatalog()
  const [busy, setBusy] = useState(false)
  if (!can('catalog.sync')) return null

  async function refresh() {
    setBusy(true)
    try {
      const state = await syncCatalog()
      const skipped = state.warnings.length
      toast.success(`Rebuilt from inventories${state.commit ? ` at ${state.commit.slice(0, 8)}` : ''}`, {
        description: skipped > 0 ? `${skipped} file${skipped === 1 ? '' : 's'} could not be read and were skipped.` : undefined,
      })
      reload()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not refresh from inventories. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant={variant} disabled={busy} onClick={refresh}>
      {busy ? <Spinner /> : <RefreshCw />}
      {busy ? 'Refreshing from inventories…' : 'Refresh from inventories'}
    </Button>
  )
}
