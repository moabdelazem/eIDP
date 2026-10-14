import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Keeps one broken part from taking the whole app with it. Without a
 * boundary, React unmounts everything on a render error and the page goes
 * blank — sidebar, header and all — which is how one unexpected request kind
 * on the Overview once looked like the portal being down.
 *
 * `page` is the shell's, around each routed page: the sidebar stays, the page
 * says what went wrong. `card` is around one part of a page (an Overview
 * card): the rest of the page stays. "Try again" draws it afresh; a change of
 * `resetKey` (the shell passes the path) does too.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; variant?: 'page' | 'card'; title?: string; resetKey?: string },
  { error: Error | null; key: string | undefined }
> {
  state: { error: Error | null; key: string | undefined } = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: Error | null; key: string | undefined }) {
    // Somewhere else now: start clean there.
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The browser console is where someone debugging looks; the API is not told.
    console.error('A part of the page failed to draw:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { variant = 'page', title } = this.props
    const retry = () => this.setState({ error: null })
    if (variant === 'card') {
      return (
        <div role="alert" className="rounded-xl border border-dashed p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 text-destructive" aria-hidden />
            {title ? `${title} could not be shown` : 'This part could not be shown'}
          </p>
          <p className="mt-1 text-muted-foreground">The rest of the page is fine. {error.message}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={retry}>
            <RotateCcw /> Try again
          </Button>
        </div>
      )
    }
    return (
      <div role="alert" className="mx-auto my-8 max-w-xl rounded-xl border bg-card p-6 shadow-sm">
        <p className="flex items-center gap-2 font-semibold">
          <TriangleAlert className="size-4 text-destructive" aria-hidden />
          This page hit an error
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Everything else in the portal still works — pick another page from the sidebar, or try this one again. If it keeps happening, tell DevOps what you
          were doing and this message:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{error.message}</pre>
        <div className="mt-4 flex gap-2">
          <Button size="sm" onClick={retry}>
            <RotateCcw /> Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload the portal
          </Button>
        </div>
      </div>
    )
  }
}
