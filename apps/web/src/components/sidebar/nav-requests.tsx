import { NavLink, useLocation } from 'react-router'
import { isItemActive, requestItems } from '@/app/nav.ts'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/** Asking DevOps for things, and following them. Everyone sees this. */
export function NavRequests() {
  const { pathname } = useLocation()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Requests</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
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
