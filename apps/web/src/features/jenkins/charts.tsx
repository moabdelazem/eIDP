import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { duration, percent, type Bucket, type Window } from './api.ts'

/**
 * The Jenkins page's charts. Lazy-loaded, like the Overview's: recharts is
 * ~330 KB that only these two need.
 *
 * Per the dataviz rules: builds stack by result because the result is a state
 * and the state is the point, from the baseline failure → unstable → success →
 * aborted (the order the validator passed), with a legend, a 2px surface gap
 * between segments and a 4px rounded top on each column's topmost segment
 * only. Success rate is its own chart — a second y-scale on the first would
 * invent a relationship — one hue, 2px, with gaps where nothing finished.
 * Both have a tooltip and an sr-only table.
 */

const SERIES = ['failure', 'unstable', 'success', 'aborted'] as const
type Series = (typeof SERIES)[number]

const resultsConfig = {
  failure: { label: 'Failed', color: 'var(--chart-failure)' },
  unstable: { label: 'Unstable', color: 'var(--chart-unstable)' },
  success: { label: 'Passed', color: 'var(--chart-success)' },
  aborted: { label: 'Aborted', color: 'var(--chart-aborted)' },
} satisfies ChartConfig

const rateConfig = { rate: { label: 'Success rate', color: 'var(--chart-1)' } } satisfies ChartConfig

/** How a bucket is named on the axis: the hour over a day, the weekday and hour over a week. */
function tick(iso: string, window: Window): string {
  const date = new Date(iso)
  return window === '24h'
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
}

/** A bucket as a range, for tooltips and tables: "Tue 30, 14:00–15:00". */
function span(iso: string, window: Window): string {
  const start = new Date(iso)
  const end = new Date(start.getTime() + (window === '24h' ? 1 : 6) * 3_600_000)
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}, ${time(start)}–${time(end)}`
}

/** Only whole days are labelled over a week, every fourth hour over a day — enough to read, few enough not to collide. */
function ticks(buckets: Bucket[], window: Window): string[] {
  return buckets
    .filter((b) => (window === '24h' ? new Date(b.at).getHours() % 4 === 0 : new Date(b.at).getHours() < 6))
    .map((b) => b.at)
}

type SegmentProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: Bucket; dataKey?: string }

/**
 * One stacked segment: square everywhere except the top of the column, which
 * gets the 4px rounded data end. Recharts rounds every segment or none, so the
 * top is worked out here — the last series in this bucket with a value.
 */
function Segment({ x = 0, y = 0, width = 0, height = 0, fill, payload, dataKey }: SegmentProps) {
  if (height <= 0 || !payload) return null
  // The 2px surface gap: each segment gives up its bottom two pixels.
  const h = Math.max(height - 2, 1)
  const top = [...SERIES].reverse().find((s) => payload[s] > 0) === dataKey
  if (!top) return <rect x={x} y={y} width={width} height={h} fill={fill} />
  const r = Math.min(4, width / 2, h)
  return (
    <path
      d={`M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + h} Z`}
      fill={fill}
    />
  )
}

export function ResultsChart({ buckets, window }: { buckets: Bucket[]; window: Window }) {
  return (
    <>
      <ChartContainer config={resultsConfig} className="h-64 w-full" aria-hidden>
        <BarChart data={buckets} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="at"
            ticks={ticks(buckets, window)}
            tickFormatter={(value: string) => tick(value, window)}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            className="text-xs"
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} className="text-xs tabular-nums" />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={<ChartTooltipContent labelFormatter={(_, items) => span(String(items?.[0]?.payload?.at ?? ''), window)} />}
          />
          <ChartLegend content={<ChartLegendContent />} />
          {SERIES.map((series: Series) => (
            <Bar key={series} dataKey={series} stackId="results" fill={`var(--color-${series})`} maxBarSize={24} shape={<Segment />} isAnimationActive={false} />
          ))}
        </BarChart>
      </ChartContainer>

      {/* In an sr-only div, not sr-only itself: a table ignores the 1px width and still widens the page on a phone. */}
      <div className="sr-only">
        <table>
          <caption>Builds by result, {window === '24h' ? 'per hour' : 'per six hours'}</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              {SERIES.map((series) => (
                <th key={series} scope="col">
                  {resultsConfig[series].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.at}>
                <td>{span(b.at, window)}</td>
                {SERIES.map((series) => (
                  <td key={series}>{b[series]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function SuccessRateChart({ buckets, window }: { buckets: Bucket[]; window: Window }) {
  const data = buckets.map((b) => ({ at: b.at, rate: b.successRate === null ? null : Math.round(b.successRate * 1000) / 10 }))
  return (
    <>
      <ChartContainer config={rateConfig} className="h-40 w-full" aria-hidden>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="at"
            ticks={ticks(buckets, window)}
            tickFormatter={(value: string) => tick(value, window)}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            className="text-xs"
          />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={48} className="text-xs tabular-nums" />
          <ChartTooltip
            cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, items) => span(String(items?.[0]?.payload?.at ?? ''), window)}
                formatter={(value) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">Success rate</span>
                    <span className="font-medium tabular-nums">{value}%</span>
                  </span>
                )}
              />
            }
          />
          {/* Gaps, not a line drawn through them: a bucket where nothing finished
              has no rate. Every point carries a marker (r 4, a 2px surface ring),
              or a lone bucket between two gaps would draw nothing at all. */}
          <Line
            dataKey="rate"
            type="linear"
            stroke="var(--color-rate)"
            strokeWidth={2}
            dot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)', fill: 'var(--color-rate)' }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>

      {/* In an sr-only div, not sr-only itself: a table ignores the 1px width and still widens the page on a phone. */}
      <div className="sr-only">
        <table>
          <caption>Success rate, {window === '24h' ? 'per hour' : 'per six hours'}</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Success rate</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.at}>
                <td>{span(b.at, window)}</td>
                <td>{b.successRate === null ? 'No builds finished' : percent(b.successRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const durationConfig = {
  p50: { label: 'Typical', color: 'var(--chart-1)' },
  p95: { label: 'Slowest 5%', color: 'var(--chart-1)' },
} satisfies ChartConfig

/** "4m", "1h 5m" — an axis needs the size, not the seconds. */
function short(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * How long builds took over the window: the typical build and the slow tail,
 * one measure on one axis. The same hue for both — they are one measure at two
 * points — told apart by the dash, the legend and the tooltip.
 */
export function DurationChart({ buckets, window }: { buckets: Bucket[]; window: Window }) {
  const data = buckets.map((b) => ({ at: b.at, p50: b.p50Ms, p95: b.p95Ms }))
  return (
    <>
      <ChartContainer config={durationConfig} className="h-56 w-full" aria-hidden>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="at"
            ticks={ticks(buckets, window)}
            tickFormatter={(value: string) => tick(value, window)}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            className="text-xs"
          />
          <YAxis tickFormatter={(v: number) => short(v)} tickLine={false} axisLine={false} width={48} className="text-xs tabular-nums" />
          <ChartTooltip
            cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, items) => span(String(items?.[0]?.payload?.at ?? ''), window)}
                formatter={(value, name) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">{durationConfig[name as 'p50' | 'p95'].label}</span>
                    <span className="font-medium tabular-nums">{duration(Number(value))}</span>
                  </span>
                )}
              />
            }
          />
          <Line
            dataKey="p95"
            type="linear"
            stroke="var(--color-p95)"
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
          {/* Markers on the typical line only: a lone bucket between two gaps still shows. */}
          <Line
            dataKey="p50"
            type="linear"
            stroke="var(--color-p50)"
            strokeWidth={2}
            dot={{ r: 3, strokeWidth: 2, stroke: 'var(--card)', fill: 'var(--color-p50)' }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
      {/* The legend draws each line as it is drawn — solid and dashed — since a
          colour swatch would show the two as one. */}
      <ul className="mt-2 flex justify-center gap-5 text-xs text-muted-foreground" aria-hidden>
        {(['p50', 'p95'] as const).map((key) => (
          <li key={key} className="flex items-center gap-1.5">
            <svg width="18" height="6" className="overflow-visible">
              <line x1="0" y1="3" x2="18" y2="3" stroke="var(--chart-1)" strokeWidth="2" strokeDasharray={key === 'p95' ? '4 3' : undefined} />
            </svg>
            {durationConfig[key].label}
          </li>
        ))}
      </ul>

      <div className="sr-only">
        <table>
          <caption>Build time, {window === '24h' ? 'per hour' : 'per six hours'}</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Typical</th>
              <th scope="col">Slowest 5%</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.at}>
                <td>{span(b.at, window)}</td>
                <td>{b.p50Ms === null ? 'No builds finished' : duration(b.p50Ms)}</td>
                <td>{b.p95Ms === null ? '' : duration(b.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export type Ranked = { label: string; value: number; detail?: string }

const rankedConfig = { value: { label: 'Builds', color: 'var(--chart-1)' } } satisfies ChartConfig

/**
 * A ranked list as horizontal bars — magnitude, one series, one hue — with the
 * number at each bar's end and the 4px rounded data end away from the
 * baseline. The rows arrive ranked and folded (top eight plus "Other") from
 * the API. Long names are cut on the axis; the tooltip and the table have them
 * whole.
 */
export function RankedBars({ rows, caption, unit }: { rows: Ranked[]; caption: string; unit: string }) {
  const name = (label: string) => (label.length > 18 ? `${label.slice(0, 17)}…` : label)
  return (
    <>
      <ChartContainer config={rankedConfig} className="w-full" style={{ height: rows.length * 34 + 8 }} aria-hidden>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" tickFormatter={name} tickLine={false} axisLine={false} width={128} className="text-xs" />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, items) => String(items?.[0]?.payload?.label ?? '')}
                formatter={(value, _name, item) => (
                  <span className="flex w-full flex-col gap-0.5">
                    <span className="font-medium tabular-nums">
                      {Number(value).toLocaleString()} {unit}
                    </span>
                    {item.payload.detail && <span className="text-muted-foreground">{item.payload.detail}</span>}
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
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">{unit}</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.value}</td>
                <td>{row.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
