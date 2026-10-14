import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRoutes } from '@/app/routes.tsx'
import { Providers } from '@/app/providers.tsx'
import { ErrorBoundary } from '@/components/error-boundary.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The last resort: the shell has its own around each page; this catches the shell and sign-in. */}
    <ErrorBoundary>
      <Providers>
        <AppRoutes />
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
)
