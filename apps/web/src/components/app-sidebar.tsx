import { LogOut } from 'lucide-react'
import { NavLink } from 'react-router'
import { navItems, requestKinds } from '@/app/nav.ts'
import { useSession } from '@/features/auth/session-context.tsx'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import logo from '@/assets/logo.png'

export function AppSidebar() {
  const { session, signOut } = useSession()

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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map(({ path, label, icon: Icon }) => (
                <SidebarMenuItem key={path}>
                  <NavLink to={path} end>
                    {({ isActive }) => (
                      <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
                        <span>
                          <Icon />
                          <span>{label}</span>
                        </span>
                      </SidebarMenuButton>
                    )}
                  </NavLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Disabled buttons swallow pointer events, so no tooltip can name
            these in the icon rail. Nothing here navigates yet, so the group
            sits out collapsed mode entirely. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Ask for</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {requestKinds.map(({ path, label, icon: Icon }) => (
                <SidebarMenuItem key={path}>
                  <SidebarMenuButton disabled>
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip={session?.name}>
                  <Avatar className="size-8 rounded-md">
                    <AvatarFallback className="rounded-md bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                      {initials(session?.name ?? '')}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate font-medium">{session?.name}</span>
                    <span className="truncate text-xs text-sidebar-foreground/60">
                      {session?.mail}
                    </span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem onClick={signOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}
