import { NavLink, useLocation } from 'react-router'
import { isItemActive, manageItems } from '@/app/nav.ts'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { requestsApi } from '@/features/requests/api.ts'
import { useSystemHealth } from '@/features/system/health-context.tsx'
import { useResource } from '@/lib/use-resource.ts'

/**
 * Pages that need a permission, set apart below a separator. Each item shows
 * only once the profile confirms the permission — not on the token's say-so —
 * so nobody else sees it, even for a moment. The pages themselves are guarded
 * in `app/routes.tsx` and the data behind them by the API; hiding the links
 * is the least of the three.
 */
export function NavManage() {
  const { can, canSomewhere } = useProfile()
  const items = manageItems.filter((item) => (item.scoped ? canSomewhere(item.permission) : can(item.permission)))
  if (items.length === 0) return null
  return <ManageGroup items={items} />
}

function ManageGroup({ items }: { items: typeof manageItems }) {
  const { pathname } = useLocation()
  const pool = useResource(() => requestsApi.pool(), [], { pollMs: 30_000 })
  const waiting = pool.data?.open.filter((r) => r.status === 'pending').length ?? 0
  const { health } = useSystemHealth()
  const down = health?.components.filter((c) => c.status === 'down').length ?? 0
  const attention = health?.components.filter((c) => c.status === 'degraded').length ?? 0

  return (
    <>
      {/* SidebarSeparator asks for w-auto, but separator.tsx sets
          data-[orientation=horizontal]:w-full, which out-specifies it — so the
          rule renders full width *plus* its mx-2 margins and spills out of the
          rail. Forcing w-auto here keeps ui/ generated and untouched. */}
      <SidebarSeparator className="w-auto!" />
      <SidebarGroup>
        <SidebarGroupLabel>Manage</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton asChild isActive={isItemActive(item, pathname)} tooltip={item.label}>
                  <NavLink to={item.path} end>
                    <item.icon />
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
                {/* Red, because it is exactly what red is for here: people
                    waiting on the person looking at it. */}
                {item.path === '/approvals' && waiting > 0 && (
                  // Keyed on the count, so a new arrival pops once and catches the eye.
                  <SidebarMenuBadge
                    key={waiting}
                    className="animate-in fade-in-0 zoom-in-50 motion-reduce:animate-none rounded-full bg-primary px-1.5 text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
                    aria-label={`${waiting} waiting`}
                  >
                    {waiting}
                  </SidebarMenuBadge>
                )}
                {/* Down is red and counted — it wants someone. Needing
                    attention is an amber dot: worth a look, not an alarm. */}
                {item.path === '/system' && down > 0 && (
                  <SidebarMenuBadge
                    key={down}
                    className="animate-in fade-in-0 zoom-in-50 motion-reduce:animate-none rounded-full bg-primary px-1.5 text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
                    aria-label={`${down} down`}
                  >
                    {down}
                  </SidebarMenuBadge>
                )}
                {item.path === '/system' && down === 0 && attention > 0 && (
                  <SidebarMenuBadge aria-label={`${attention} need${attention === 1 ? 's' : ''} attention`} title={`${attention} need${attention === 1 ? 's' : ''} attention`}>
                    <span className="size-2 rounded-full bg-[var(--sidebar-warning)]" />
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}
