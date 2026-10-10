import { browseItems } from '@/app/nav.ts'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '@/components/ui/sidebar'
import { NavManage } from './nav-manage.tsx'
import { NavMain } from './nav-main.tsx'
import { NavRequests } from './nav-requests.tsx'
import { NavUser } from './nav-user.tsx'
import logo from '@/assets/logo.png'

/**
 * Grouped by what you are doing: browsing what exists, asking for something
 * new, and — below a separator, for DevOps only — deciding and administering.
 * Each group is its own component — a new group is a new file mounted here,
 * not another branch inside one long component.
 */
export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img src={logo} alt="" className="size-6 shrink-0" />
          <span className="grid leading-tight group-data-[collapsible=icon]:hidden">
            <span className="font-semibold tracking-tight">e-IDP</span>
            <span className="text-xs text-rail-muted">DEVOPS Portal</span>
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <NavMain label="Browse" items={browseItems} />
        <NavRequests />
        <NavManage />
      </SidebarContent>

      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}
