import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { highlight, type Language } from '@/lib/highlight.ts'

/**
 * Any object as highlighted YAML or JSON, with copy and download.
 *
 * shadcn has no code or syntax-highlighting component — only a styled inline
 * <code> — so this is ours, on Shiki. Use it wherever someone might want the
 * data behind a page rather than the page's reading of it.
 */
export function DataView({
  data,
  filename,
  defaultFormat = 'yaml',
  className = '',
}: {
  data: unknown
  /** Download name without extension, e.g. `agriland-api`. */
  filename: string
  defaultFormat?: Language
  className?: string
}) {
  const [format, setFormat] = useState<Language>(defaultFormat)
  const [text, setText] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Keyed on the serialised text, not the object: callers build `data` inline,
  // so its identity changes every render, and an effect keyed on it would
  // re-run — and re-render — forever. A string compares by value.
  const json = useMemo(() => JSON.stringify(data, null, 2), [data])

  useEffect(() => {
    let stale = false
    setHtml(null)
    const serialised =
      format === 'json'
        ? Promise.resolve(json)
        : // Loaded on demand like Shiki: the YAML library is not in the main
          // bundle. lineWidth 0 never folds a long value across lines, which
          // would make copied YAML differ from what the files hold.
          import('yaml').then(({ stringify }) =>
            stringify(JSON.parse(json), { lineWidth: 0, aliasDuplicateObjects: false }),
          )
    serialised
      .then(async (next) => {
        if (stale) return
        setText(next)
        // Highlighting is a nicety; the plain text is already correct.
        // The trailing newline is kept for copy and download — files should
        // end with one — but not drawn, or it becomes an empty numbered line.
        const highlighted = await highlight(next.replace(/\n$/, ''), format).catch(() => null)
        if (!stale && highlighted) setHtml(highlighted)
      })
      .catch(() => !stale && setText(json)) // YAML failed to load: JSON is still the data
    return () => {
      stale = true
    }
  }, [json, format])

  async function copy() {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.')
    }
  }

  function download() {
    if (text === null) return
    const type = format === 'json' ? 'application/json' : 'application/yaml'
    const url = URL.createObjectURL(new Blob([text], { type }))
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: `${filename}.${format === 'json' ? 'json' : 'yaml'}`,
    })
    link.click()
    URL.revokeObjectURL(url)
  }

  const shown = text ?? ''
  const lines = shown.endsWith('\n') ? shown.split('\n').length - 1 : shown.split('\n').length

  return (
    <div data-slot="data-view" className={`overflow-hidden rounded-lg border bg-card ${className}`}>
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <ToggleGroup
          type="single"
          size="sm"
          value={format}
          onValueChange={(next) => next && setFormat(next as Language)}
          aria-label="Format"
        >
          <ToggleGroupItem value="yaml" className="h-7 px-2.5 font-mono text-xs">YAML</ToggleGroupItem>
          <ToggleGroupItem value="json" className="h-7 px-2.5 font-mono text-xs">JSON</ToggleGroupItem>
        </ToggleGroup>
        {text !== null && (
          <span className="text-xs text-muted-foreground">
            {lines} line{lines === 1 ? '' : 's'}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy as ${format.toUpperCase()}`}>
            {copied ? <Check /> : <Copy />}
            <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={download} aria-label={`Download as ${format.toUpperCase()}`}>
            <Download />
            <span className="hidden sm:inline">Download</span>
          </Button>
        </div>
      </div>

      <div className="data-view max-h-[32rem] overflow-auto text-[13px] leading-relaxed">
        {text === null ? (
          // Only on the very first YAML view, while the serialiser loads.
          <div className="space-y-2 p-4">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ) : html ? (
          // Shiki escapes every token it emits, so data cannot inject markup.
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          // Same text, same metrics, unhighlighted — so nothing jumps when
          // the colours arrive.
          <pre className="shiki">
            <code>
              {text.replace(/\n$/, '').split('\n').map((line, index) => (
                <span key={index} className="line">
                  {line}
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  )
}
