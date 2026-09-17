/**
 * Host pattern matching — shared by every policy that decides something per
 * hostname (browser navigation allowlist, proxy routing).
 *
 * Deliberately dependency-free so any tier can import it: the alternative was
 * exporting these from `browser-policy.service`, which would drag config,
 * product-config and security-policy into unrelated call sites.
 */

/**
 * Parse a dotted-quad IPv4 string into a 32-bit unsigned integer.
 * Returns null for anything that is not a strictly-formatted IPv4 address,
 * so callers can cleanly distinguish IPs from hostnames.
 */
export function parseIPv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null

  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0 // force unsigned 32-bit
}

/**
 * Match an IPv4 hostname against a CIDR pattern (e.g. "10.0.0.0/8").
 * Returns false for any malformed pattern or non-IPv4 hostname, never throws.
 *
 * - `/0` matches every IPv4 address.
 * - `/32` requires an exact address match.
 */
export function matchCidr(hostname: string, pattern: string): boolean {
  const slashIndex = pattern.indexOf('/')
  if (slashIndex === -1) return false

  const prefixText = pattern.slice(slashIndex + 1)
  if (!/^\d{1,2}$/.test(prefixText)) return false
  const prefix = Number(prefixText)
  if (prefix > 32) return false

  const hostInt = parseIPv4(hostname)
  const baseInt = parseIPv4(pattern.slice(0, slashIndex))
  if (hostInt === null || baseInt === null) return false

  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return ((hostInt & mask) >>> 0) === ((baseInt & mask) >>> 0)
}

/**
 * Match a hostname against a domain or IP pattern.
 *
 * Supported patterns:
 * - "*.example.com"  → matches "example.com" and any subdomain (e.g. "app.example.com")
 * - "example.com"    → exact hostname match
 * - "10.0.0.0/8"     → IPv4 CIDR range (only matches IPv4 hostnames)
 * - "192.168.1.1"    → exact IPv4 match (handled by the exact-match branch)
 *
 * A bare domain does NOT cover its subdomains — unlike the NO_PROXY
 * convention. Callers that want subdomains must write the `*.` form.
 */
export function matchDomainPattern(hostname: string, pattern: string): boolean {
  const lowerHost = hostname.toLowerCase()
  const lowerPattern = pattern.toLowerCase()

  // CIDR ranges only make sense for IPv4 hostnames; matchCidr safely rejects
  // hostname-vs-CIDR and IP-vs-domain mismatches.
  if (lowerPattern.includes('/')) {
    return matchCidr(lowerHost, lowerPattern)
  }

  if (lowerPattern.startsWith('*.')) {
    const baseDomain = lowerPattern.slice(2) // "example.com"
    return lowerHost === baseDomain || lowerHost.endsWith('.' + baseDomain)
  }

  return lowerHost === lowerPattern
}
