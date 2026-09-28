import { LogOut, UserRound } from 'lucide-react'
import { Link } from 'react-router'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useSession } from '@/features/auth/session-context.tsx'

/** Who you are signed in as, where to see more, and the way out. */
export function NavUser() {
  const { session, signOut } = useSession()
  const { profile } = useProfile()
  if (!session) return null

  // The role people know you by reads better than an email address.
  const subtitle = profile?.title ?? profile?.department ?? session.mail

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip={session.name}>
              <Avatar className="size-8 rounded-md">
                <AvatarFallback className="rounded-md bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                  {initials(session.name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-medium">{session.name}</span>
                <span className="truncate text-xs text-sidebar-foreground/60">{subtitle}</span>
              </div>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuItem asChild>
              <Link to="/me">
                <UserRound />
                Your profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}
