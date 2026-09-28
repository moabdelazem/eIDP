import { Fragment } from 'react'
import { Link } from 'react-router'
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { isAvailable, typesByProvider } from './kinds.ts'

/**
 * The New request menu: every request type, grouped by the system it lands
 * in. The same menu opens from the sidebar and from My requests, so the two
 * can never offer different things.
 */
export function NewRequestMenuContent(props: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent className="min-w-64 rounded-lg" {...props}>
      {typesByProvider().map(({ provider, types }, index) => (
        <Fragment key={provider.id}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{provider.label}</DropdownMenuLabel>
          <DropdownMenuGroup>
            {types.map((type) =>
              isAvailable(type) ? (
                <DropdownMenuItem key={type.path} asChild className="items-start gap-3 py-2">
                  <Link to={type.path}>
                    <type.icon className="mt-0.5" />
                    <span className="grid leading-tight">
                      <span>{type.label}</span>
                      <span className="text-xs text-muted-foreground">{type.description}</span>
                    </span>
                  </Link>
                </DropdownMenuItem>
              ) : (
                // Listed, so people know it is coming; disabled, so nobody
                // fills in a form nothing can act on.
                <DropdownMenuItem key={type.path} disabled className="items-start gap-3 py-2">
                  <type.icon className="mt-0.5" />
                  <span className="grid leading-tight">
                    <span>{type.label}</span>
                    <span className="text-xs text-muted-foreground">{type.description}</span>
                  </span>
                  <span className="ml-auto self-center rounded-full border px-1.5 text-[10px] text-muted-foreground">
                    Soon
                  </span>
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuGroup>
        </Fragment>
      ))}
    </DropdownMenuContent>
  )
}
