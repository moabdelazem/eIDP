import { browseItems, requestItems } from '@/app/nav.ts'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import { NavMain } from './nav-main.tsx'
import { NavRequests } from './nav-requests.tsx'
import { NavUser } from './nav-user.tsx'
import logo from '@/assets/logo.png'

/**
 * Grouped by what you are doing: browsing what exists, then asking for
 * something new. Each group is its own component — a new group is a new file
 * mounted here, not another branch inside one long component.
 */
export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img src={logo} alt="" className="size-6 shrink-0" />
          <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            e-IDP
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <NavMain label="Browse" items={browseItems} />
        {/* SidebarSeparator asks for w-auto, but separator.tsx sets
            data-[orientation=horizontal]:w-full, which out-specifies it — so the
            rule renders full width *plus* its mx-2 margins and spills out of the
            sidebar. Forcing w-auto here keeps ui/ generated and untouched. */}
        <SidebarSeparator className="w-auto! group-data-[collapsible=icon]:hidden" />
      </SidebarContent>

      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}
