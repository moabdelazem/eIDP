import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'

export type Datum = { name: string; count: number }

const config = {
  count: { label: 'Applications', color: 'var(--chart-1)' },
} satisfies ChartConfig

/**
 * One series, ranked, as horizontal bars — names like
 * NBFS_LoanManagementSystem need the room a column axis cannot give.
 *
 * Per the dataviz rules: one hue and no legend box (the title names the
 * series), bars capped at 16px with a 4px rounded data end and a square
 * baseline, the value at each tip in a text colour rather than the bar's, no
 * gridlines because every bar is labelled, a hover tooltip, and a table for
 * anyone who cannot use the chart.
 */
export function RankedBars({
  data,
  label,
  onSelect,
}: {
  data: Datum[]
  /** Names the table for screen readers, e.g. "Applications by technology". */
  label: string
  onSelect?: (name: string) => void
}) {
  const height = Math.max(data.length * 30 + 8, 60)

  return (
    <>
      <ChartContainer config={config} className="w-full" style={{ height }} aria-hidden>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" dataKey="count" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={160}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            // Long system names are cut with an ellipsis; the tooltip and the
            // table keep the full name.
            tickFormatter={(value: string) => (value.length > 18 ? `${value.slice(0, 17)}…` : value)}
            className="text-xs"
          />
          <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent hideIndicator />} />
          <Bar
            dataKey="count"
            fill="var(--color-count)"
            radius={[0, 4, 4, 0]}
            maxBarSize={16}
            className={onSelect ? 'cursor-pointer' : undefined}
            onClick={onSelect ? (entry: { name?: string }) => entry.name && onSelect(entry.name) : undefined}
            // Motion answers nothing here — the bars are the page's content,
            // not a response to an action — so they draw once, without a
            // growing animation.
            isAnimationActive={false}
          >
            <LabelList dataKey="count" position="right" offset={8} className="fill-foreground text-xs tabular-nums" />
          </Bar>
        </BarChart>
      </ChartContainer>

      {/* In an sr-only div, not sr-only itself: a table ignores the 1px width and still widens the page on a phone. */}
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Applications</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
