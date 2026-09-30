import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { percent, type Bucket, type Window } from './api.ts'

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
