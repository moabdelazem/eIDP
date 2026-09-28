import { ShieldX } from 'lucide-react'
import { Link, Outlet } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'

/**
 * Guards DevOps-only pages against being opened by link. Waits for the
 * directory's answer rather than trusting the token, so nothing behind it
 * renders — or fetches — for anyone the directory does not put in DevOps.
 *
 * The API refuses the data regardless; this keeps the page itself, and its
 * requests, from ever starting.
 */
export function RequireDevOps() {
  const { isApprover, loaded, profile } = useProfile()

  if (!loaded) return <Skeleton className="h-40 w-full max-w-3xl" />
  if (isApprover) return <Outlet />
  return <Denied approverGroup={profile?.approverGroup} />
}

function Denied({ approverGroup }: { approverGroup?: string }) {
  usePageTitle('Not available')
  return (
    <div className="max-w-prose">
      <ShieldX className="size-6 text-muted-foreground" />
      <h1 className="mt-3 text-lg font-semibold tracking-tight">This page is for the DevOps team</h1>
      <p className="mt-2 text-muted-foreground">
        Only members of {approverGroup ?? 'DevOps'} can open it. You can follow what you
        have asked for in{' '}
        <Link to="/requests" className="underline">
          My requests
        </Link>
        .
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        In the team and still seeing this?{' '}
        <Link to="/me" className="underline">
          Your profile
        </Link>{' '}
        shows what the directory reports about you.
      </p>
    </div>
  )
}
