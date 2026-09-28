import { NavLink, useLocation } from 'react-router'
import { devopsItems, isItemActive } from '@/app/nav.ts'
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
import { useResource } from '@/lib/use-resource.ts'

/**
 * DevOps-only pages, set apart below a separator. Rendered only once the
 * directory confirms membership — not on the token's say-so — so nobody else
 * ever sees it, even for a moment. The pages themselves are guarded in
 * `app/routes.tsx` and the data behind them by the API; hiding the links is
 * the least of the three.
 */
export function NavDevOps() {
  const { isApprover } = useProfile()
  if (!isApprover) return null
  return <DevOpsGroup />
}

function DevOpsGroup() {
  const { pathname } = useLocation()
  const pool = useResource(() => requestsApi.pool(), [], { pollMs: 30_000 })
  const waiting = pool.data?.open.filter((r) => r.status === 'pending').length ?? 0

  return (
    <>
      {/* SidebarSeparator asks for w-auto, but separator.tsx sets
          data-[orientation=horizontal]:w-full, which out-specifies it — so the
          rule renders full width *plus* its mx-2 margins and spills out of the
          rail. Forcing w-auto here keeps ui/ generated and untouched. */}
      <SidebarSeparator className="w-auto!" />
      <SidebarGroup>
        <SidebarGroupLabel>DevOps</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {devopsItems.map((item) => (
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
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}
