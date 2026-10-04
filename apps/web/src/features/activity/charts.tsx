import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import type { ActivityWindow, Overview } from './api.ts'

/**
 * Platform activity's charts. Lazy-loaded, like every page's charts: recharts
 * is ~330 KB that only this page needs here.
 *
 * Both are one series in one hue (`--chart-1`), with the 4px rounded data end
 * away from the baseline, a tooltip, and the numbers again in an sr-only
 * table. Days are UTC days, as the API counts them, so the labels say UTC
 * dates rather than shifting a bar across midnight.
 */

const peopleConfig = { people: { label: 'People', color: 'var(--chart-1)' } } satisfies ChartConfig
const pagesConfig = { value: { label: 'Visits', color: 'var(--chart-1)' } } satisfies ChartConfig

function when(iso: string, window: ActivityWindow, long = false): string {
  const date = new Date(iso)
  if (window === '24h') return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: long || window === '7d' ? 'short' : undefined, day: 'numeric', month: long || window === '30d' ? 'short' : undefined })
}

/** Distinct people active in each hour (a day) or day (a week, a month). */
export function ActivePeopleChart({ series, window }: { series: Overview['series']; window: ActivityWindow }) {
  // Every fourth hour over a day, every fifth day over a month: enough to read, few enough not to collide.
  const every = window === '24h' ? 4 : window === '30d' ? 5 : 1
  const ticks = series.filter((_, i) => (series.length - 1 - i) % every === 0).map((s) => s.at)
  return (
    <>
      <ChartContainer config={peopleConfig} className="h-56 w-full" aria-hidden>
        <BarChart data={series} margin={{ top: 8, right: 4, bottom: 0, left: -16 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="at" ticks={ticks} tickFormatter={(v: string) => when(v, window)} tickLine={false} axisLine={false} tickMargin={8} className="text-xs" />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} className="text-xs tabular-nums" />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, items) => when(String(items?.[0]?.payload?.at ?? ''), window, true)}
                formatter={(value, _name, item) => (
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium tabular-nums">
                      {Number(value).toLocaleString()} {Number(value) === 1 ? 'person' : 'people'}
                    </span>
                    <span className="text-muted-foreground">{Number(item.payload.events).toLocaleString()} things done</span>
                  </span>
                )}
              />
            }
          />
          <Bar dataKey="people" fill="var(--color-people)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <div className="sr-only">
        <table>
          <caption>People active {window === '24h' ? 'each hour' : 'each day (UTC)'}</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">People</th>
              <th scope="col">Things done</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.at}>
                <td>{when(s.at, window, true)}</td>
                <td>{s.people}</td>
                <td>{s.events}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** The parts of the portal people opened, ranked, top eight plus "Other" from the API. */
export function PagesChart({ sections }: { sections: Overview['sections'] }) {
  const name = (label: string) => (label.length > 18 ? `${label.slice(0, 17)}…` : label)
  return (
    <>
      <ChartContainer config={pagesConfig} className="w-full" style={{ height: sections.length * 34 + 8 }} aria-hidden>
        <BarChart data={sections} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" tickFormatter={name} tickLine={false} axisLine={false} width={128} className="text-xs" />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, items) => String(items?.[0]?.payload?.label ?? '')}
                formatter={(value, _name, item) => (
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium tabular-nums">{Number(value).toLocaleString()} visits</span>
                    <span className="text-muted-foreground">
                      by {item.payload.people} {item.payload.people === 1 ? 'person' : 'people'}
                    </span>
                  </span>
                )}
              />
            }
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
            <LabelList dataKey="value" position="right" offset={6} className="fill-foreground text-xs tabular-nums" />
          </Bar>
        </BarChart>
      </ChartContainer>
      <div className="sr-only">
        <table>
          <caption>Pages opened, by part of the portal</caption>
          <thead>
            <tr>
              <th scope="col">Part of the portal</th>
              <th scope="col">Visits</th>
              <th scope="col">People</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <tr key={s.label}>
                <td>{s.label}</td>
                <td>{s.value}</td>
                <td>{s.people}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
