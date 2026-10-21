import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type Project = { name: string; description: string | null }

/**
 * A searchable list of names — projects in a collection, or someone's
 * directory groups. Either can run to hundreds, and a plain select makes people
 * scroll for the one they already know the name of.
 */
export function ProjectPicker({
  id,
  projects,
  value,
  onChange,
  loading,
  noun = 'project',
  after,
}: {
  id: string
  projects: Project[]
  value: string
  onChange: (name: string) => void
  loading: boolean
  noun?: string
  /** What has to be chosen first ("a project"): until then the picker says so instead of looking like it loads. */
  after?: string
}) {
  const [open, setOpen] = useState(false)
  const nouns = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={loading || Boolean(after)}
          className="w-full justify-between font-normal"
        >
          <span className={value ? '' : 'text-muted-foreground'}>
            {after ? `Choose ${after} first` : loading ? `Loading ${nouns}…` : value || `Choose a ${noun}`}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${nouns}`} />
          <CommandList>
            <CommandEmpty>No {noun} by that name.</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.name}
                  value={project.name}
                  onSelect={() => {
                    onChange(project.name)
                    setOpen(false)
                  }}
                >
                  <Check className={value === project.name ? 'opacity-100' : 'opacity-0'} />
                  <div className="min-w-0">
                    <div className="truncate">{project.name}</div>
                    {project.description && (
                      <div className="truncate text-xs text-muted-foreground">{project.description}</div>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
