import { NavLink, useLocation } from 'react-router'
import { isItemActive, type NavItem } from '@/app/nav.ts'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/** A group of real destinations. */
export function NavMain({ label, items }: { label: string; items: NavItem[] }) {
  // NavLink's own isActive can't stay lit on a detail page, so ask nav.ts
  // which section owns this path.
  const { pathname } = useLocation()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton
                asChild
                isActive={isItemActive(item, pathname)}
                tooltip={item.label}
              >
                <NavLink to={item.path}>
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
