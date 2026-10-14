import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { BrowserRouter } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { SessionProvider } from '@/features/auth/session-context.tsx'
import { queryClient } from '@/lib/query-client.ts'

/**
 * Everything the whole app needs in scope. Add new providers here. The
 * query client is the one cache of API answers (`lib/query-client.ts`).
 *
 * The theme is next-themes': light, dark or the system's, kept per browser
 * (`eidp.theme`), applied as the `dark` class on <html>. Before the first
 * paint it is index.html's own script that sets it, so a dark page never
 * flashes paper first: the script next-themes renders never runs in an SPA
 * (React does not run scripts it renders). It is marked a data block, which
 * is what it is here, so React 19 does not warn about it on every page.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="eidp.theme" scriptProps={{ type: 'application/json' }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SessionProvider>{children}</SessionProvider>
          <Toaster position="bottom-right" />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
