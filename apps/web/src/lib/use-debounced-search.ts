import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A search box that answers every keystroke but commits only once typing
 * pauses. What it commits — the URL's `q`, a query key, a filter over a
 * thousand rows — is the expensive part, and doing it per keystroke froze
 * the projects map for over a second while someone typed.
 *
 * `committed` is the value as the page holds it (often the URL's). The box
 * shows `text`; `onCommit` runs `ms` after the last keystroke, at once on
 * `flush` (Enter), and never for the value already committed. A change from
 * outside — Clear, a chip, back/forward — replaces what is in the box.
 *
 * No library: a timer does it.
 */
export function useDebouncedSearch(committed: string, onCommit: (value: string) => void, ms = 250) {
  const [text, setText] = useState(committed)
  // Taken from outside (React's "adjust state when a prop changes"): Clear, a chip, the URL on back/forward.
  const [seen, setSeen] = useState(committed)
  if (committed !== seen) {
    setSeen(committed)
    setText(committed)
  }

  const commit = useRef(onCommit)
  useEffect(() => {
    commit.current = onCommit
  })

  useEffect(() => {
    if (text === committed) return
    const timer = setTimeout(() => commit.current(text), ms)
    return () => clearTimeout(timer)
  }, [text, committed, ms])

  const flush = useCallback(() => {
    if (text !== committed) commit.current(text)
  }, [text, committed])

  return { text, setText, flush }
}
