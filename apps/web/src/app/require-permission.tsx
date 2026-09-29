import { ShieldX } from 'lucide-react'
import { Link, Outlet } from 'react-router'
import { useProfile, type Permission } from '@/features/auth/profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { HeaderSkeleton, Loading } from '@/components/skeletons.tsx'
import { PAGE } from '@/components/page-layout.tsx'

/**
 * Guards pages that need a permission against being opened by link. Waits for
 * the directory-backed answer rather than trusting the token, so nothing
 * behind it renders — or fetches — for anyone without it.
 *
 * The API refuses the data regardless; this keeps the page itself, and its
 * requests, from ever starting.
 */
export function RequirePermission({ permission, scoped = false }: { permission: Permission; scoped?: boolean }) {
  const { can, canSomewhere, loaded } = useProfile()

  if (!loaded) {
    return (
      <Loading className={PAGE}>
        <HeaderSkeleton />
      </Loading>
    )
  }
  if (scoped ? canSomewhere(permission) : can(permission)) return <Outlet />
  return <Denied />
}

function Denied() {
  usePageTitle('Not available')
  return (
    <div className="max-w-prose">
      <ShieldX className="size-6 text-muted-foreground" />
      <h1 className="mt-3 text-lg font-semibold tracking-tight">You don’t have access to this page</h1>
      <p className="mt-2 text-muted-foreground">
        None of your roles include it. You can follow what you have asked for in{' '}
        <Link to="/requests" className="underline">
          My requests
        </Link>
        .
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Expected to have it?{' '}
        <Link to="/me" className="underline">
          Your profile
        </Link>{' '}
        lists every role you hold and where each comes from.
      </p>
    </div>
  )
}
