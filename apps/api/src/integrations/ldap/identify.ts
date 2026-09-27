import type { Client } from 'ldapts'

export type ServerIdentity = {
  vendor: string
  /** Suffixes the server actually serves — candidates for LDAP_BASE_DN. */
  namingContexts: string[]
  /** Active Directory's own idea of where a login lives. */
  defaultNamingContext: string | null
  isActiveDirectory: boolean
}

/**
 * Reads the rootDSE, which every LDAP server publishes and most allow
 * anonymously. It names the product and the suffixes it serves, which is the
 * fastest way to find out what you are actually talking to.
 */
export async function identifyServer(client: Client): Promise<ServerIdentity | null> {
  try {
    const { searchEntries } = await client.search('', {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: [
        'vendorName',
        'vendorVersion',
        'namingContexts',
        'defaultNamingContext',
        'rootDomainNamingContext',
        'supportedCapabilities',
        'objectClass',
        'dnsHostName',
      ],
    })

    const root = searchEntries[0]
    if (!root) return null

    const values = (key: string): string[] =>
      [root[key]]
        .flat()
        .filter((v) => v !== undefined && v !== '')
        .map(String)

    const defaultNamingContext = values('defaultNamingContext')[0] ?? null
    // 1.2.840.113556.1.4.800 is LDAP_CAP_ACTIVE_DIRECTORY_OID.
    const isActiveDirectory =
      values('supportedCapabilities').includes('1.2.840.113556.1.4.800') ||
      defaultNamingContext !== null

    return {
      vendor: describeVendor(values, isActiveDirectory),
      namingContexts: values('namingContexts'),
      defaultNamingContext,
      isActiveDirectory,
    }
  } catch {
    // Plenty of directories refuse an anonymous rootDSE read. Not knowing the
    // vendor is not a failure; the later stages still work.
    return null
  }
}

function describeVendor(values: (key: string) => string[], isActiveDirectory: boolean): string {
  if (isActiveDirectory) {
    const host = values('dnsHostName')[0]
    return host ? `Active Directory (${host})` : 'Active Directory'
  }

  const name = values('vendorName')[0]
  const version = values('vendorVersion')[0]
  if (name) return [name, version].filter(Boolean).join(' ')

  const classes = values('objectClass')
  if (classes.some((c) => c.toLowerCase() === 'openldaprootdse')) return 'OpenLDAP'
  return version ?? 'unknown (the server does not advertise a vendor)'
}

/** The filter idiom each product expects for "one person by login name". */
export function suggestedSettings(identity: ServerIdentity | null): {
  objectClass: string
  attribute: string
  filter?: string
} {
  if (identity?.isActiveDirectory) {
    return {
      objectClass: 'user',
      attribute: 'sAMAccountName',
      // objectCategory=person is the canonical AD idiom: objectClass=user also
      // matches computer accounts, which are user objects in AD.
      filter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))',
    }
  }
  return { objectClass: 'inetOrgPerson', attribute: 'uid' }
}
