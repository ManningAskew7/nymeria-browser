/**
 * URL comparison for trust decisions, shared so the rules cannot drift.
 *
 * Two graded questions live here. `sameResource` asks "same fetched
 * document?" and ignores the fragment entirely: it is what statusWatch uses
 * to attribute an HTTP status to a navigation, where `/page` and `/page#sec`
 * are one response. `sameDocumentUrl` asks "may refs minted there still be
 * trusted here?", which is stricter: a fragment that IS the page's router
 * state (hash routing, `#/cart` or `#!/inbox`) changes what is rendered
 * without changing the resource, so it counts as moving. Plain anchor
 * fragments (`#pricing`) still do not bounce held refs.
 */

/** URL equality with the fragment ignored (parser-based, so trailing-slash
 *  and host-case normalization come from the URL parser, not string games).
 *  Unparseable input compares false: no claim is safer than a guessed one. */
export function sameResource(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    ua.hash = ''
    ub.hash = ''
    return ua.href === ub.href
  } catch {
    return false
  }
}

/** A fragment that encodes ROUTER state rather than a scroll anchor: the
 *  hash-routing conventions start it with `/` (vue/react hash mode, angular)
 *  or `!` (the old hashbang scheme). */
function routeFragment(u: URL): string | null {
  const h = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
  return h.startsWith('/') || h.startsWith('!') ? h : null
}

/**
 * Whether refs minted at `a` are still trustworthy at `b`: same resource,
 * and no hash-ROUTE change (either side having a route fragment the other
 * does not match is a move; two plain anchors, or anchor vs none, is not).
 * Null on either side means unknown, which compares false: refs must never
 * survive on a guess.
 */
export function sameDocumentUrl(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  if (!sameResource(a, b)) return false
  try {
    return routeFragment(new URL(a)) === routeFragment(new URL(b))
  } catch {
    return false
  }
}
