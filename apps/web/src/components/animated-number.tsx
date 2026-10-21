import { useLayoutEffect, useRef } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * A count that rolls to its new value instead of jumping, so a tile that
 * changes while you watch (a build failing, a request decided) says that it
 * changed. The first value is shown as it is, never counted up from zero: a
 * number arriving is not news, a number moving is. With reduced motion it
 * simply changes.
 *
 * Takes the text a tile already shows. Only a whole number ("1,204") rolls;
 * anything else ("8s", "100%", "—") is shown as it is.
 *
 * The rolling digits are written straight to an element React leaves empty —
 * React and the animation must never both own one text node — and hidden from
 * screen readers, which hear the final value once.
 */
export function AnimatedNumber({ value, className }: { value: string | number; className?: string }) {
  const text = typeof value === 'number' ? value.toLocaleString() : value
  const n = /^-?[\d,]+$/.test(text) ? Number(text.replaceAll(',', '')) : null
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef<number | null>(null)
  const reduce = useReducedMotion()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || n === null) return
    const from = shown.current
    shown.current = n
    if (from === null || from === n || reduce) {
      el.textContent = n.toLocaleString()
      return
    }
    // A plain frame loop: one number easing out over 600ms needs no animation engine.
    const start = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / 600)
      const eased = 1 - (1 - t) ** 4
      el.textContent = Math.round(from + (n - from) * eased).toLocaleString()
      if (t < 1) frame = requestAnimationFrame(tick)
    })
    return () => {
      cancelAnimationFrame(frame)
      el.textContent = n.toLocaleString()
    }
  }, [n, reduce])

  const classes = className ? `tabular-nums ${className}` : 'tabular-nums'
  if (n === null) return <span className={classes}>{text}</span>
  return (
    <span className={classes}>
      <span ref={ref} aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  )
}
