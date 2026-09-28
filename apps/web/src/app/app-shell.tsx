import { Outlet, useLocation } from 'react-router'
import { AppSidebar } from '@/components/sidebar/app-sidebar.tsx'
import { CommandPalette } from '@/components/command-palette.tsx'
import { PageBreadcrumbs } from '@/components/page-breadcrumbs.tsx'
import { ProfileProvider } from '@/features/auth/profile-context.tsx'
import { CatalogProvider } from '@/features/projects/catalog-context.tsx'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

export function AppShell() {
  const { pathname } = useLocation()
  return (
    // SidebarProvider writes sidebar_state but only reads it back server-side
    // in Next, so a plain SPA has to hand the saved value in itself.
    <SidebarProvider defaultOpen={!document.cookie.includes('sidebar_state=false')}>
      <ProfileProvider>
        <CatalogProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mr-1 h-4" />
              <PageBreadcrumbs />
              <CommandPalette />
            </header>
            {/* Keyed on the path, so each navigation plays the entrance once.
                A search-param change (the map's ?q=) keeps the key and the
                page, rather than replaying it on every keystroke. A div, not a
                main: SidebarInset is already the page's one <main>. */}
            <div key={pathname} className="page-enter p-8">
              <Outlet />
            </div>
          </SidebarInset>
        </CatalogProvider>
      </ProfileProvider>
    </SidebarProvider>
  )
}
