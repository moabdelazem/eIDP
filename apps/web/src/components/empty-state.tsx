import type { ReactNode } from 'react'

/** A screen with nothing on it yet. Says what will fill it, not just that it is empty. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-prose">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-muted-foreground">{children}</p>
    </div>
  )
}
