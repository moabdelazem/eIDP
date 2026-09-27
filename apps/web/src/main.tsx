import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRoutes } from '@/app/routes.tsx'
import { Providers } from '@/app/providers.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <AppRoutes />
    </Providers>
  </StrictMode>,
)
