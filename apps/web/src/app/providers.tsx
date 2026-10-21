import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { LazyMotion, MotionConfig } from 'motion/react'
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
 *
 * Motion (`motion/react`) animates what CSS cannot: a number rolling to its
 * new value, a list item leaving, a card sliding to its new place. Components
 * use `m.*`, never `motion.*` (`strict` enforces it), and the features
 * themselves load in their own chunk after the first paint (`lib/motion-features.ts`). `reducedMotion="user"` turns every transform off for
 * anyone whose system asks for reduced motion, as the CSS motion does.
 */
const loadMotion = () => import('@/lib/motion-features.ts').then((module) => module.default)

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="eidp.theme" scriptProps={{ type: 'application/json' }}>
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={loadMotion} strict>
          <MotionConfig reducedMotion="user">
            <BrowserRouter>
              <SessionProvider>{children}</SessionProvider>
              <Toaster position="bottom-right" />
            </BrowserRouter>
          </MotionConfig>
        </LazyMotion>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
