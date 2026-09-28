import { ChevronRight, Plus } from 'lucide-react'
import { NavLink, useLocation } from 'react-router'
import { isItemActive, requestItems } from '@/app/nav.ts'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { NewRequestMenuContent } from '@/features/requests/new-request-menu.tsx'

/**
 * Asking DevOps for things, and following them. Everyone sees this.
 *
 * Request types sit behind one New request menu rather than one sidebar item
 * each: there will be many, across Azure DevOps, Jira and more, and a flat
 * list would push everything below it off the screen. A dropdown also works
 * in the collapsed icon rail, where nested items have nowhere to go.
 */
export function NavRequests() {
  const { pathname } = useLocation()
  const { isMobile } = useSidebar()
  const creating = pathname.startsWith('/requests/new')

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Requests</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton isActive={creating} tooltip="New request">
                  <Plus />
                  <span>New request</span>
                  <ChevronRight className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              {/* 14px clears the rail's own 8px padding plus a gap, so the menu
                  sits beside the sidebar rather than on its edge — in both the
                  full width and the icon rail, which share that padding. */}
              <NewRequestMenuContent side={isMobile ? 'bottom' : 'right'} align="start" sideOffset={isMobile ? 6 : 14} />
            </DropdownMenu>
          </SidebarMenuItem>

          {requestItems.map((item) => (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton asChild isActive={isItemActive(item, pathname)} tooltip={item.label}>
                <NavLink to={item.path} end>
                  <item.icon />
                  <span>{item.label}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
