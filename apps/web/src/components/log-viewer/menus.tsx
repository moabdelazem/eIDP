import { ChevronDown, Layers, Settings2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import type { StageNode } from './parse.ts'
import type { LogPrefs } from './prefs.ts'

/** Every stage heading, each with its errors — a jump, not a filter. */
export function StageMenu({ stages, onGo }: { stages: StageNode[]; onGo: (line: number) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8">
          <Layers /> Stages <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel>Go to a stage</DropdownMenuLabel>
        {stages.map((s) => (
          <DropdownMenuItem key={s.line} onSelect={() => onGo(s.line)} style={{ paddingLeft: `${0.5 + s.depth * 0.875}rem` }}>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {s.errors > 0 && (
              <span className="flex items-center gap-1 text-xs text-destructive tabular-nums">
                <TriangleAlert className="size-3 text-destructive" aria-hidden />
                {s.errors}
                <span className="sr-only">{s.errors === 1 ? 'error' : 'errors'}</span>
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** How the log reads, kept per browser (prefs.ts), and the keys it answers to. */
export function ViewMenu({
  prefs: { wrap, hideSteps, times, size, colours, highlight, tree },
  setPref,
  timed,
  coloured,
  staged,
}: {
  prefs: LogPrefs
  setPref: <K extends keyof LogPrefs>(key: K, value: LogPrefs[K]) => void
  /** Whether the log has `timestamps {}` prefixes to show. */
  timed: boolean
  /** Whether the log has ANSI colours of its own. */
  coloured: boolean
  /** Whether the log has stages for a tree. */
  staged: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8" aria-label="View settings">
          <Settings2 />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>View</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={(v) => setPref('wrap', v === true)} onSelect={(e) => e.preventDefault()}>
          Wrap long lines <DropdownMenuShortcut>W</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={hideSteps} onCheckedChange={(v) => setPref('hideSteps', v === true)} onSelect={(e) => e.preventDefault()}>
          Hide [Pipeline] steps
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={times} onCheckedChange={(v) => setPref('times', v === true)} onSelect={(e) => e.preventDefault()} disabled={!timed}>
          Show timestamps
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={colours} onCheckedChange={(v) => setPref('colours', v === true)} onSelect={(e) => e.preventDefault()} disabled={!coloured}>
          The log’s own colours
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={highlight} onCheckedChange={(v) => setPref('highlight', v === true)} onSelect={(e) => e.preventDefault()}>
          Highlight syntax
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={tree} onCheckedChange={(v) => setPref('tree', v === true)} onSelect={(e) => e.preventDefault()} disabled={!staged} className="hidden lg:flex">
          Stage tree beside the log <DropdownMenuShortcut>T</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Text size</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={size} onValueChange={(v) => setPref('size', v as typeof size)}>
          <DropdownMenuRadioItem value="sm" onSelect={(e) => e.preventDefault()}>Small</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="md" onSelect={(e) => e.preventDefault()}>Medium</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="lg" onSelect={(e) => e.preventDefault()}>Large</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Keys: <Kbd>/</Kbd> find · <Kbd>e</Kbd> next error · <Kbd>f</Kbd> expand · <Kbd>w</Kbd> wrap · <Kbd>t</Kbd> tree · <Kbd>[</Kbd> fold all · <Kbd>]</Kbd> unfold all
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
