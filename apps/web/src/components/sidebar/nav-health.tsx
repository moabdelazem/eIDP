import { CircleX } from 'lucide-react'
import { NavLink } from 'react-router'
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useSystemHealth } from '@/features/system/health-context.tsx'

/**
 * An alert at the foot of the sidebar while something the portal depends on
 * is down — on every page, so DevOps hear of it before the people it breaks
 * for do. Red, because it wants someone. Only for down: a warning is a dot on
 * System health, not an alarm on every page. Collapsed to the icon rail it is
 * one red icon whose tooltip says what is down.
 */
export function NavHealth() {
  const { health } = useSystemHealth()
  const down = health?.components.filter((c) => c.status === 'down') ?? []
  if (!health || down.length === 0) return null

  const names = down.map((c) => c.name).join(', ')
  const title = health.status === 'down' ? 'The portal is down' : down.length === 1 ? `${down[0]!.name} is down` : `${down.length} systems are down`
  const detail = health.status === 'down' || down.length > 1 ? names : 'Pages that use it will not work until it is back.'
  // One down already names itself in the title.
  const said = down.length === 1 && health.status !== 'down' ? title : `${title}: ${names}`

  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip={said}
              className="h-auto border border-sidebar-primary/50 bg-sidebar-primary/15 py-2 hover:bg-sidebar-primary/25 group-data-[collapsible=icon]:h-8! group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:py-0"
            >
              <NavLink to="/system" aria-label={`${said}. Open System health.`}>
                <CircleX className="text-sidebar-primary" aria-hidden />
                <span className="grid min-w-0 leading-tight whitespace-normal! group-data-[collapsible=icon]:hidden">
                  <span className="font-medium">{title}</span>
                  <span className="line-clamp-2 text-xs text-rail-muted">{detail}</span>
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* Announced once when it appears; the link above stays a link. */}
        <span role="alert" className="sr-only">
          {said}
        </span>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
