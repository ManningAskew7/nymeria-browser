import { describe, expect, it } from 'vitest'
import { SELECTOR_IDENTITY_SNIPPET } from './selectorIdentity'

/**
 * The snippet runs IN PAGE, so it is exercised in page rather than staged at
 * a mock: a mock that returns the ANSWER pins the caller's plumbing and
 * leaves the mechanism free to be deleted with every test still green (the
 * #210 review's finding, applied across this family).
 */

describe('which selector answered (executed in-page)', () => {
  /**
   * The helper runs IN PAGE, so it is exercised in page, not staged at the
   * mock: a mock that returns the ANSWER pins the caller's plumbing and
   * leaves the mechanism free to be deleted with every test still green
   * (the #210 review's finding, applied across this family).
   */
  function identity(root: Element, selector: string): string | null {
    return (
      new Function(
        `${SELECTOR_IDENTITY_SNIPPET} return nymSelectorIdentity(arguments[0], arguments[1])`,
      ) as (r: Element, s: string) => string | null
    )(root, selector)
  }

  function parts(selector: string): string[] {
    return (
      new Function(`${SELECTOR_IDENTITY_SNIPPET} return nymSelectorParts(arguments[0])`) as (
        s: string,
      ) => string[]
    )(selector)
  }

  function el(html: string): Element {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild as Element
  }

  it('names which candidate in a list the read root satisfies', () => {
    // The shape that motivated this: a defensive multi-selector read against
    // an SPA whose class names move between releases. The first real-world
    // drive wrote exactly this and could not tell which container it sampled,
    // which decides whether the piece letters #190 counts could ever have
    // been there.
    const root = el('<div class="move-list"></div>')

    expect(identity(root, '.play-controller-moveList, wc-simple-move-list, .move-list')).toBe(
      '.move-list',
    )
  })

  it('names EVERY candidate the element satisfies, not just the first', () => {
    // A list can name one element two ways, and choosing between them would
    // be a claim the DOM does not support. A PROPER subset, because an
    // element satisfying all of them is the separate silence rule below.
    const root = el('<div class="a b"></div>')

    expect(identity(root, '.a, .b, .c')).toBe('.a, .b')
  })

  it('says nothing when the element satisfies EVERY candidate', () => {
    // The same non-answer as a single selector: the note would restate the
    // caller's whole argument and narrow nothing (review round).
    expect(identity(el('<div class="a b"></div>'), '.a, .b')).toBeNull()
  })

  it('does not treat a backslash-escaped comma as a separator', () => {
    // `CSS.escape` output for a class literally named `a,b`. Splitting it
    // yields `.a\\` (which throws and is skipped) and `b` (which can match
    // something unrelated), so a caller who passed ONE selector was told the
    // read matched `'b'`, a string they never wrote (review round).
    expect(parts('.a\\,b')).toEqual(['.a\\,b'])
    expect(identity(el('<b class="a,b"></b>'), '.a\\,b')).toBeNull()
  })

  it('does not let an escaped quote at top level swallow the rest of the list', () => {
    expect(parts(".a\\'b, .c, .d")).toEqual([".a\\'b", '.c', '.d'])
  })

  it('says nothing when the selector was not a list', () => {
    // The identity of a single selector is what the caller typed, and a note
    // that restates the argument is wallpaper.
    expect(identity(el('<div class="a"></div>'), '.a')).toBeNull()
  })

  it('says nothing when the element satisfies no part, rather than guessing', () => {
    // Reachable through a shadow-piercing or frame-scoped root later: the
    // honest answer is silence, never the first candidate.
    expect(identity(el('<div class="c"></div>'), '.a, .b')).toBeNull()
  })

  it('does not split a comma that belongs to the selector', () => {
    // `:is(a, b)`, `:not(a, b)` and `[x="a,b"]` all carry commas that a naive
    // split turns into fragments that are not selectors at all.
    expect(parts(':is(h1, h2), .x')).toEqual([':is(h1, h2)', '.x'])
    expect(parts('[data-k="a,b"], .y')).toEqual(['[data-k="a,b"]', '.y'])
    expect(parts('div:not(.a, .b)')).toEqual(['div:not(.a, .b)'])
  })

  it('does not let a bracket INSIDE a quoted value close the bracket it is in', () => {
    // The one case depth-counting alone gets wrong, and a real selector: the
    // `]` inside the quotes would close the attribute early, so the comma
    // after it would split a single selector into two fragments, neither of
    // which is one.
    expect(parts('[t="],a"], .z')).toEqual(['[t="],a"]', '.z'])
  })

  it('keeps an escaped quote from opening a run that swallows the rest', () => {
    expect(parts('[t="a\\"b"], .z')).toEqual(['[t="a\\"b"]', '.z'])
  })

  it('skips a malformed candidate instead of throwing or reporting it', () => {
    // Worst case is NO identity, never a wrong one.
    const root = el('<div class="ok"></div>')

    expect(identity(root, 'div:::broken, .ok')).toBe('.ok')
  })
})
