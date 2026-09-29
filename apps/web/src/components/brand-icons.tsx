import type { SVGProps } from 'react'

/**
 * The systems e-IDP talks to, by their own marks — Lucide dropped brand icons,
 * and a package for two paths would be more than the paths. From Simple Icons
 * (CC0), 24×24 like Lucide's, so they size with the same `size-4` classes.
 *
 * `tone="brand"` (the default) draws each in its product colour, which is how
 * people recognise it at a glance; `tone="current"` inherits the text colour
 * for places where colour would be noise, like a muted heading.
 */
type BrandIconProps = SVGProps<SVGSVGElement> & { tone?: 'brand' | 'current' }

function BrandIcon({
  path,
  color,
  title,
  tone = 'brand',
  className = 'size-4',
  ...props
}: BrandIconProps & { path: string; color: string; title: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      className={`shrink-0 ${className}`}
      fill={tone === 'brand' ? color : 'currentColor'}
      {...props}
    >
      <path d={path} />
    </svg>
  )
}

export function AzureDevOpsIcon(props: BrandIconProps) {
  return (
    <BrandIcon
      title="Azure DevOps"
      color="#0078D7"
      path="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z"
      {...props}
    />
  )
}

export function JiraIcon(props: BrandIconProps) {
  return (
    <BrandIcon
      title="Jira"
      color="#0052CC"
      path="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"
      {...props}
    />
  )
}
