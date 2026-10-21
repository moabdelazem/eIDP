import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRoutes } from '@/app/routes.tsx'
import { Providers } from '@/app/providers.tsx'
import { ErrorBoundary } from '@/components/error-boundary.tsx'
// Fonts ship with the app: an internal network often cannot reach Google Fonts, and the portal fell back to the system font.
// Archivo with its width axis (wdth.css), so display headings can be set wider than body text.
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource-variable/jetbrains-mono/index.css'
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
