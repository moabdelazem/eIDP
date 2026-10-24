import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useSession } from '@/features/auth/session-context.tsx'
import { fetchAppearance, rememberAppearance, storedTheme } from '@/lib/appearance.ts'
import { setPalette, storedPalette } from '@/lib/palette.ts'

/**
 * Once someone is signed in, their theme and colours from their account —
 * so a new browser, another machine or cleared site data looks the way they
 * left it. Someone who chose before choices were kept with the account has
 * this browser's choice saved as theirs, once.
 *
 * Not while an admin views the portal as someone else: that session is
 * read-only, and the admin keeps their own look.
 */
export function AppearanceSync() {
  const { session } = useSession()
  const { setTheme } = useTheme()
  const uid = session && !session.actor ? session.uid : null

  useEffect(() => {
    if (!uid) return
    let stale = false
    fetchAppearance()
      .then(({ appearance }) => {
        if (stale) return
        if (appearance) {
          setTheme(appearance.theme)
          setPalette(appearance.palette)
        } else {
          rememberAppearance({ theme: storedTheme(), palette: storedPalette() })
        }
      })
      .catch(() => {
        // The browser's own choice stands.
      })
    return () => {
      stale = true
    }
  }, [uid, setTheme])

  return null
}
