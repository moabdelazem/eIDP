import { useState } from 'react'
import { FolderGit2, Inbox, KeyRound, LogOut, Map, Workflow } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import type { Session } from '@/auth'
import logo from '@/assets/logo.png'

const views = {
  map: {
    label: 'Project map',
    icon: Map,
    empty: {
      title: 'No projects yet',
      body: (
        <>
          The map is built from the <code>engine</code> repository. Point e-IDP at one and every
          project in the organization shows up here.
        </>
      ),
    },
  },
  requests: {
    label: 'Requests',
    icon: Inbox,
    empty: {
      title: 'Nothing requested yet',
      body: <>Ask for a repository, a pipeline, or access to something, and track it here.</>,
    },
  },
} as const

type ViewKey = keyof typeof views

const askFor = [
  { label: 'A repository', icon: FolderGit2 },
  { label: 'A pipeline', icon: Workflow },
  { label: 'Access to a repository', icon: KeyRound },
]

export function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [view, setView] = useState<ViewKey>('map')
  const current = views[view]

  return (
    // SidebarProvider writes sidebar_state but only reads it back server-side
    // in Next, so a plain SPA has to hand the saved value in itself.
    <SidebarProvider defaultOpen={!document.cookie.includes('sidebar_state=false')}>
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
                {(Object.keys(views) as ViewKey[]).map((key) => {
                  const Icon = views[key].icon
                  return (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        isActive={view === key}
                        tooltip={views[key].label}
                        onClick={() => setView(key)}
                      >
                        <Icon />
                        <span>{views[key].label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Ask for</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {askFor.map(({ label, icon: Icon }) => (
                  <SidebarMenuItem key={label}>
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
                  <SidebarMenuButton size="lg" tooltip={session.name}>
                    <Avatar className="size-8 rounded-md">
                      <AvatarFallback className="rounded-md bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                        {initials(session.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="truncate font-medium">{session.name}</span>
                      <span className="truncate text-xs text-sidebar-foreground/60">
                        {session.mail}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuItem onClick={onSignOut}>
                    <LogOut />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <h1 className="font-medium">{current.label}</h1>
        </header>

        <main className="p-8">
          <div className="max-w-prose">
            <h2 className="text-lg font-semibold tracking-tight">{current.empty.title}</h2>
            <p className="mt-2 text-muted-foreground">{current.empty.body}</p>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}
