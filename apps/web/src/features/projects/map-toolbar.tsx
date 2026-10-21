import { useEffect, useRef } from 'react'
import { Check, ChevronDown, LayoutList, Network, Search, X } from 'lucide-react'
import { cn } from 'cn'
import type { Environment } from './catalog.ts'
import { envLabel, isProduction, type Filters } from './tree.ts'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

type Facets = { technologies: { name: string; count: number }[]; environments: { name: Environment; count: number }[] }

type Props = {
  filters: Filters
  onChange: (filters: Filters) => void
  facets: Facets
  /** What the filters leave of the whole, so their effect shows. */
  showing: { systems: number; applications: number }
  total: { systems: number; applications: number }
  view: 'map' | 'list'
  onView: (view: 'map' | 'list') => void
}

/**
 * Search, filters and the view. Environments are chips — five at most, one
 * click each; technologies can run to dozens, so they are a searchable list.
 * `/` jumps to the search from anywhere on the page.
 */
export function MapToolbar({ filters, onChange, facets, showing, total, view, onView }: Props) {
  const search = useRef<HTMLInputElement>(null)
  const narrowed = filters.technologies.length + filters.environments.length > 0 || filters.query.trim() !== ''

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key !== '/' || event.metaKey || event.ctrlKey || target.closest('input, textarea, [contenteditable=true]')) return
      event.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={search}
            value={filters.query}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
            onKeyDown={(event) => event.key === 'Escape' && filters.query && onChange({ ...filters, query: '' })}
            placeholder="Search systems, applications, repositories"
            aria-label="Search systems, applications and repositories"
            className="bg-card pr-10 pl-9"
          />
          {filters.query ? (
            <Button size="icon" variant="ghost" className="absolute top-1/2 right-1 size-7 -translate-y-1/2" onClick={() => onChange({ ...filters, query: '' })} aria-label="Clear the search">
              <X />
            </Button>
          ) : (
            <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2" aria-hidden>
              /
            </Kbd>
          )}
        </div>

        <TechnologyPicker facets={facets.technologies} selected={filters.technologies} onChange={(technologies) => onChange({ ...filters, technologies })} />

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          // Radix clears a single group when the active item is clicked again; a view must always be chosen.
          onValueChange={(next) => next && onView(next as 'map' | 'list')}
          aria-label="View"
          className="bg-card"
        >
          <ToggleGroupItem value="map" className="px-3" aria-label="Map">
            <Network /> <span className="hidden sm:inline">Map</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="list" className="px-3" aria-label="List">
            <LayoutList /> <span className="hidden sm:inline">List</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {facets.environments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Runs in">
            <span className="mr-1 text-xs text-muted-foreground">Runs in</span>
            {facets.environments.map(({ name, count }) => {
              const on = filters.environments.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ ...filters, environments: on ? filters.environments.filter((e) => e !== name) : [...filters.environments, name] })}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                    on ? 'border-ring bg-secondary text-secondary-foreground' : 'bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  {isProduction(name) && <span aria-hidden className="size-1.5 rounded-full bg-[var(--chart-1)]" />}
                  {envLabel(name)}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              )
            })}
          </div>
        )}

        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          {narrowed ? (
            <>
              <span>
                <b className="font-medium text-foreground tabular-nums">{showing.systems}</b> of {total.systems} systems ·{' '}
                <b className="font-medium text-foreground tabular-nums">{showing.applications}</b> of {total.applications} applications
              </span>
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onChange({ query: '', technologies: [], environments: [] })}>
                <X /> Clear
              </Button>
            </>
          ) : (
            <span>
              <b className="font-medium text-foreground tabular-nums">{total.systems}</b> systems · <b className="font-medium text-foreground tabular-nums">{total.applications}</b> applications
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

function TechnologyPicker({ facets, selected, onChange }: { facets: { name: string; count: number }[]; selected: string[]; onChange: (selected: string[]) => void }) {
  if (facets.length === 0) return null
  const toggle = (name: string) => onChange(selected.includes(name) ? selected.filter((v) => v !== name) : [...selected, name])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('h-9 bg-card', selected.length > 0 && 'border-ring')}>
          {selected.length === 0 ? 'Any technology' : selected.length === 1 ? selected[0] : `${selected.length} technologies`}
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find a technology" />
          <CommandList>
            <CommandEmpty>No technology by that name.</CommandEmpty>
            <CommandGroup>
              {facets.map(({ name, count }) => (
                <CommandItem key={name} value={name} onSelect={() => toggle(name)}>
                  <Check className={cn('size-4', selected.includes(name) ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="flex-1 truncate">{name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {selected.length > 0 && (
            <div className="border-t p-1">
              <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onChange([])}>
                <X /> Any technology
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
