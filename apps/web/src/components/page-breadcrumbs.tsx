import { Fragment } from 'react'
import { Link, useLocation } from 'react-router'
import { crumbsFor } from '@/app/breadcrumbs.ts'
import { BACK, placeFor } from '@/lib/places.ts'
import { useCatalog } from '@/features/projects/catalog-context.tsx'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

/** Where you are, and the way back up. */
export function PageBreadcrumbs() {
  const crumbs = crumbsFor(useLocation().pathname, useCatalog().systems)

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.path ?? crumb.label}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.path ? (
                <BreadcrumbLink asChild>
                  {/* Up a level is a way back: to the list as it was left — its filters, page and scroll. */}
                  <Link to={placeFor(crumb.path)} state={BACK}>
                    {crumb.label}
                  </Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
