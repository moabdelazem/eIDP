import type { ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { SessionProvider } from '@/features/auth/session-context.tsx'

/** Everything the whole app needs in scope. Add new providers here. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <SessionProvider>{children}</SessionProvider>
      <Toaster position="bottom-right" />
    </BrowserRouter>
  )
}
