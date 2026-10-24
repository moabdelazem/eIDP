import { LogOut, Monitor, Moon, Palette as PaletteIcon, Sun, UserRound } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Link } from 'react-router'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useSession } from '@/features/auth/session-context.tsx'
import { rememberAppearance, type ThemeChoice } from '@/lib/appearance.ts'
import { setPalette, usePalette, type Palette } from '@/lib/palette.ts'

/** Who you are signed in as, where to see more, the theme and colours, and the way out. */
export function NavUser() {
  const { session, signOut } = useSession()
  const { profile } = useProfile()
  const { theme = 'system', setTheme } = useTheme()
  const palette = usePalette()
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
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />}
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) => {
                    setTheme(value)
                    // Kept with the account too, so every browser they use looks the same.
                    rememberAppearance({ theme: value as ThemeChoice, palette })
                  }}
                >
                  <DropdownMenuRadioItem value="light">
                    <Sun /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor /> Same as the system
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* Which colours, beside light or dark: the classic eggplant, or the e-finance navy and red (lib/palette.ts). */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PaletteIcon />
                Colours
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={palette}
                  onValueChange={(value) => {
                    setPalette(value as Palette)
                    rememberAppearance({ theme: (theme as ThemeChoice) ?? 'system', palette: value as Palette })
                  }}
                >
                  <DropdownMenuRadioItem value="classic">
                    <Swatch name="classic" /> Classic
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="efinance">
                    <Swatch name="efinance" /> e-finance
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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

/** A palette at a glance: its ground and its signal, side by side. */
function Swatch({ name }: { name: Palette }) {
  return (
    <span aria-hidden className="flex overflow-hidden rounded-full ring-1 ring-border">
      <span className="size-3" style={{ background: `var(--swatch-${name}-ground)` }} />
      <span className="size-3" style={{ background: `var(--swatch-${name}-signal)` }} />
    </span>
  )
}
