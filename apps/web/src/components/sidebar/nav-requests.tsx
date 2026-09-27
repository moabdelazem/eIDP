import type { NavItem } from '@/app/nav.ts'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/**
 * The things people can ask for. Each one is disabled until it is built —
 * a dim item that says what is coming beats a link that goes nowhere.
 *
 * Disabled buttons swallow pointer events, so no tooltip can name them in the
 * icon rail; the whole group sits out collapsed mode until they work.
 */
export function NavRequests({ items }: { items: NavItem[] }) {
  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Ask for</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(({ path, label, icon: Icon }) => (
            <SidebarMenuItem key={path}>
              <SidebarMenuButton disabled={true}>
                <Icon />
                <span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
