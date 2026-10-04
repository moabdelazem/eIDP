import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const PRESETS = [
  { id: 'never', label: 'Never', days: null },
  { id: '7', label: '1 week', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: '365', label: '1 year', days: 365 },
] as const

/** yyyy-mm-dd, in the browser's own calendar. */
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function dayFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return isoDay(d)
}

/** The end of a chosen day, in the browser's time zone, as the API takes it — or null for never. */
export function expiryToIso(day: string): string | null {
  return day ? new Date(`${day}T23:59:59`).toISOString() : null
}

export function isoToDay(iso: string | null): string {
  return iso ? isoDay(new Date(iso)) : ''
}

/**
 * When a binding stops granting: never, a common span from today, or a day
 * picked by hand. A preset fills the day in; changing the day by hand leaves
 * the presets unpressed, so what shows is always what will be saved.
 */
export function ExpiryField({ id, value, onChange }: { id: string; value: string; onChange: (day: string) => void }) {
  const pressed = value === '' ? 'never' : (PRESETS.find((p) => p.days !== null && dayFromNow(p.days) === value)?.id ?? '')
  return (
    <div className="space-y-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={pressed}
        onValueChange={(next) => {
          const preset = PRESETS.find((p) => p.id === next)
          if (preset) onChange(preset.days === null ? '' : dayFromNow(preset.days))
        }}
        aria-label="Expires after"
        className="flex-wrap"
      >
        {PRESETS.map((p) => (
          <ToggleGroupItem key={p.id} value={p.id} className="px-3">
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} type="date" min={dayFromNow(1)} value={value} onChange={(e) => onChange(e.target.value)} className="w-44" aria-label="Expiry date" />
        <span className="text-xs text-muted-foreground">
          {value
            ? `Stops granting at the end of ${new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}.`
            : 'Grants until someone removes it.'}
        </span>
      </div>
    </div>
  )
}
