import { Check, ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react'
import type { Environment } from './catalog.ts'
import type { Filters } from './tree.ts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

type Props = {
  filters: Filters
  onChange: (filters: Filters) => void
  facets: { technologies: string[]; environments: Environment[] }
  /** What the current filters leave behind, so the effect is visible. */
  showing: { systems: number; applications: number }
  view: 'map' | 'list'
  onView: (view: 'map' | 'list') => void
  onExpandAll: () => void
  onCollapseAll: () => void
}

export function MapToolbar({
  filters,
  onChange,
  facets,
  showing,
  view,
  onView,
  onExpandAll,
  onCollapseAll,
}: Props) {
  const active = filters.technologies.length + filters.environments.length
  const narrowed = active > 0 || filters.query.trim() !== ''

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.query}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
            placeholder="Search by name or repository"
            aria-label="Search systems, applications, repositories"
            className="pl-9"
          />
        </div>

        <FacetPicker
          label="Technology"
          options={facets.technologies}
          selected={filters.technologies}
          onChange={(technologies) => onChange({ ...filters, technologies })}
        />
        <FacetPicker
          label="Environment"
          options={facets.environments}
          selected={filters.environments}
          onChange={(environments) =>
            onChange({ ...filters, environments: environments as Environment[] })
          }
        />

        {narrowed && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ query: '', technologies: [], environments: [] })}>
            <X /> Clear
          </Button>
        )}

        <Separator orientation="vertical" className="mx-1 h-6" />

        {view === 'map' && (
          <>
            <Button variant="outline" size="sm" onClick={onExpandAll} aria-label="Expand everything shown" title="Expand everything shown">
              <ChevronsUpDown />
            </Button>
            <Button variant="outline" size="sm" onClick={onCollapseAll} aria-label="Collapse to the top level" title="Collapse to the top level">
              <ChevronsDownUp />
            </Button>
          </>
        )}

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          // Radix clears a single group when the active item is clicked again;
          // a view must always be chosen, so an empty value is ignored.
          onValueChange={(next) => next && onView(next as 'map' | 'list')}
          aria-label="View"
        >
          <ToggleGroupItem value="map" className="px-3">Map</ToggleGroupItem>
          <ToggleGroupItem value="list" className="px-3">List</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <p className="text-sm text-muted-foreground">
        {narrowed ? 'Showing ' : ''}
        <span className="font-medium text-foreground">{showing.systems}</span>{' '}
        {showing.systems === 1 ? 'system' : 'systems'} ·{' '}
        <span className="font-medium text-foreground">{showing.applications}</span>{' '}
        {showing.applications === 1 ? 'application' : 'applications'}
        {narrowed && showing.systems === 0 && ' — nothing matches those filters.'}
      </p>
    </div>
  )
}

function FacetPicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (selected: string[]) => void
}) {
  if (options.length === 0) return null

  function toggle(option: string) {
    onChange(selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
          {selected.length > 0 && (
            <Badge variant="secondary" className="ml-1 px-1.5">
              {selected.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <ul className="max-h-72 overflow-auto">
          {options.map((option) => (
            <li key={option}>
              <button
                type="button"
                onClick={() => toggle(option)}
                aria-pressed={selected.includes(option)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Check
                  className={`size-4 shrink-0 ${selected.includes(option) ? 'opacity-100' : 'opacity-0'}`}
                />
                <span className="truncate">{option}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
