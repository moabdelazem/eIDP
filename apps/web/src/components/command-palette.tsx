import { useEffect, useMemo, useState } from 'react'
import { AppWindow, Boxes, Search } from 'lucide-react'
import { useNavigate } from 'react-router'
import { browseItems, manageItems, requestItems, type NavItem } from '@/app/nav.ts'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useCatalog } from '@/features/projects/catalog-context.tsx'
import { isAvailable, REQUEST_TYPES } from '@/features/requests/kinds.ts'

const MAX_APPLICATIONS = 12
const MAX_SYSTEMS = 6

const onMac = /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Jump to anything: an application, a system, or a page. Ctrl/⌘ K anywhere,
 * or the search button in the header — a shortcut nobody can see is one
 * nobody uses.
 *
 * Filters itself rather than letting cmdk do it: cmdk filters by mounting every
 * item and hiding the misses, and with ~1100 applications that is 1100 hidden
 * rows on every keystroke. Only the best matches are ever rendered.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
        aria-keyshortcuts={onMac ? 'Meta+K' : 'Control+K'}
      >
        <Search />
        <span className="hidden sm:inline">Jump to…</span>
        <KbdGroup className="hidden sm:inline-flex">
          <Kbd>{onMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
          <DialogTitle className="sr-only">Jump to</DialogTitle>
          <DialogDescription className="sr-only">
            Search applications, systems and pages.
          </DialogDescription>
          {open && <Palette onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Palette({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const { systems } = useCatalog()
  const { can, canSomewhere } = useProfile()
  const [query, setQuery] = useState('')

  // Pages that need a permission are offered only to people who hold it — the
  // same rule as the sidebar.
  // Request types come from the registry by their full title, so "repository"
  // and "azure" both find one; only the ones with a form are offered.
  const pages: NavItem[] = useMemo(
    () => [
      ...browseItems,
      ...REQUEST_TYPES.filter(isAvailable).map((type) => ({ path: type.path, label: type.title, icon: type.icon })),
      ...requestItems,
      ...manageItems.filter((item) => (item.scoped ? canSomewhere(item.permission) : can(item.permission))),
    ],
    [can, canSomewhere],
  )

  const needle = query.trim().toLowerCase()

  const matches = useMemo(() => {
    const score = (text: string) => {
      const value = text.toLowerCase()
      if (!needle) return 0
      if (value === needle) return 3
      if (value.startsWith(needle)) return 2
      return value.includes(needle) ? 1 : -1
    }

    const applications = needle
      ? systems
          .flatMap((system) =>
            system.applications.map((app) => ({
              app,
              system,
              score: Math.max(score(app.name), score(app.repository ?? '')),
            })),
          )
          .filter((m) => m.score >= 0)
          .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name))
          .slice(0, MAX_APPLICATIONS)
      : []

    const matchedSystems = needle
      ? systems
          .map((system) => ({ system, score: score(system.projectName) }))
          .filter((m) => m.score >= 0)
          .sort((a, b) => b.score - a.score || a.system.projectName.localeCompare(b.system.projectName))
          .slice(0, MAX_SYSTEMS)
      : []

    const matchedPages = pages.filter((page) => !needle || page.label.toLowerCase().includes(needle))

    return { applications, systems: matchedSystems, pages: matchedPages }
  }, [needle, systems, pages])

  function go(path: string) {
    onDone()
    navigate(path)
  }

  return (
    <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search applications, systems and pages"
        className="h-12"
      />
      <CommandList className="max-h-[min(60vh,28rem)]">
        <CommandEmpty>Nothing by that name. Try part of a repository name.</CommandEmpty>

        {matches.applications.length > 0 && (
          <CommandGroup heading="Applications">
            {matches.applications.map(({ app, system }) => (
              <CommandItem
                key={`${system.id}/${app.id}`}
                value={`app:${system.id}/${app.id}`}
                onSelect={() => go(`/projects/${encodeURIComponent(app.id)}`)}
              >
                <AppWindow className="text-muted-foreground" />
                <span className="truncate font-mono">{app.name}</span>
                <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                  {system.projectName}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {matches.systems.length > 0 && (
          <CommandGroup heading="Systems">
            {matches.systems.map(({ system }) => (
              <CommandItem
                key={system.id}
                value={`system:${system.id}`}
                onSelect={() => go(`/map?q=${encodeURIComponent(system.projectName)}`)}
              >
                <Boxes className="text-muted-foreground" />
                <span className="truncate">{system.projectName}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {system.applications.length} app{system.applications.length === 1 ? '' : 's'}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {matches.pages.length > 0 && (
          <CommandGroup heading="Pages">
            {matches.pages.map((page) => (
              <CommandItem key={page.path} value={`page:${page.path}`} onSelect={() => go(page.path)}>
                <page.icon className="text-muted-foreground" />
                {page.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )
}
