import { Sparkles } from 'lucide-react'
import { useSearchParams } from 'react-router'

/**
 * Said at the top of a request form the chatbot filled in: it drafts, never
 * files — the person reads it over and submits it themselves.
 */
export function DraftedNote() {
  const [params] = useSearchParams()
  if (params.get('from') !== 'chatbot') return null
  return (
    <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--chart-1)]" aria-hidden />
      The chatbot filled this in from your conversation. Check every field — nothing is filed until you submit it.
    </p>
  )
}
