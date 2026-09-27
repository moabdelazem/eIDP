import type { ReactNode } from 'react'

/** A screen with nothing on it yet. Says what will fill it, not just that it is empty. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-prose">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-muted-foreground">{children}</p>
    </div>
  )
}
