import { NavLink, useLocation } from 'react-router'
import { approvalsItem, isItemActive, requestItems, type NavItem } from '@/app/nav.ts'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { requestsApi } from '@/features/requests/api.ts'
import { useResource } from '@/lib/use-resource.ts'

export function NavRequests() {
  const { pathname } = useLocation()
  const { isApprover: approver } = useProfile()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Requests</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {requestItems.map((item) => (
            <Item key={item.path} item={item} active={isItemActive(item, pathname)} />
          ))}
          {approver && <ApprovalsItem active={isItemActive(approvalsItem, pathname)} />}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function Item({ item, active, badge }: { item: NavItem; active: boolean; badge?: React.ReactNode }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <NavLink to={item.path} end>
          <item.icon />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
      {badge}
    </SidebarMenuItem>
  )
}

/**
 * The count is red because it is exactly what red is for here: people waiting
 * on the person looking at it.
 */
function ApprovalsItem({ active }: { active: boolean }) {
  const pool = useResource(() => requestsApi.pool(), [], { pollMs: 30_000 })
  const waiting = pool.data?.open.filter((r) => r.status === 'pending').length ?? 0

  return (
    <Item
      item={approvalsItem}
      active={active}
      badge={
        waiting > 0 && (
          <SidebarMenuBadge
            className="rounded-full bg-primary px-1.5 text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
            aria-label={`${waiting} waiting`}
          >
            {waiting}
          </SidebarMenuBadge>
        )
      }
    />
  )
}
