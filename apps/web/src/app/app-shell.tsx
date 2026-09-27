import { Outlet, useLocation } from 'react-router'
import { AppSidebar } from '@/components/app-sidebar.tsx'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { titleFor } from './nav.ts'

export function AppShell() {
  const { pathname } = useLocation()

  return (
    // SidebarProvider writes sidebar_state but only reads it back server-side
    // in Next, so a plain SPA has to hand the saved value in itself.
    <SidebarProvider defaultOpen={!document.cookie.includes('sidebar_state=false')}>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <h1 className="font-medium">{titleFor(pathname)}</h1>
        </header>
        <main className="p-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
