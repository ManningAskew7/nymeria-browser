/**
 * The open-shadow-root walk, as probe-body source.
 *
 * Lives in its own module because two different probes need the SAME walk and
 * must agree about it: the `css=` resolution in `commands/act.ts` (stop at
 * the first match) and the ambiguity count folded into `SELECTOR_FACTS_FN` in
 * `input.ts` (add up every match). A count taken over a different set of
 * roots than the resolution searched is worse than no count, because it reads
 * as a measured "only one match" (review round).
 *
 * Everything here is a STRING built for `Runtime.evaluate` /
 * `Runtime.callFunctionOn`, so it obeys probe-body discipline: prototype-
 * backed access only, `typeof` guards over truthiness (a named form control
 * shadows a document property), and per-step try/catch so one hostile
 * getter cannot end the walk.
 *
 * Currently only the ACT path uses it. `chrome_read_page`'s `scope_selector`
 * and `extract_text` still take the document-only reading; aligning them is a
 * filed follow-up, and this module is the piece it reuses.
 */

/**
 * Bounds on the walk a missed selector pays for.
 *
 * The walk only ever runs when the ordinary document query matched NOTHING,
 * so a selector that resolves normally pays none of it. Bounded in three
 * directions for the same reason the wait's frame scan is: a pathological
 * page must not turn one resolution into an unbounded DOM traversal, and a
 * bound that was hit is REPORTED rather than passed off as an exhaustive
 * search. The root cap is a WHOLE-WALK total, not a per-level one (a
 * per-level cap made the real bound depth x cap, which no docstring said).
 */
export const SHADOW_WALK_MAX_NODES = 2_000
export const SHADOW_WALK_MAX_DEPTH = 5
export const SHADOW_WALK_MAX_ROOTS = 50

/** Marker prefixes the css resolution returns BY VALUE. A `Runtime.evaluate`
 *  gives primitives back on the RemoteObject even with `returnByValue: false`
 *  (only objects need an objectId), so the walk's findings ride home on the
 *  same round trip that would otherwise report a bare null. */
export const SELECTOR_MISS = 'nym-miss:'
export const SELECTOR_INVALID = 'nym-invalid'

/**
 * The walk itself, as a statement block.
 *
 * `perRoot` is JS run once for each open root reached, with `root` in scope
 * and free to `return`; `q` (the selector) must already be in scope. After
 * the block, `open` (roots searched), `hosts` (custom-element tags seen with
 * no reachable root) and `capped` (a bound cut the search short) are in scope
 * for the caller to report.
 *
 * Breadth-first: the shallowest roots are searched first, so a "first match"
 * taken from here is document order only WITHIN one root.
 *
 * The depth bound runs ONE pass past the last searched level, scanning it
 * without searching it, purely to answer whether anything was left
 * uncollected. Without that pass, "roots still in hand" was read as a cut
 * search, so a page nested exactly to the limit and no deeper reported "not
 * exhaustive" about a search that had in fact seen everything (review round).
 */
export function shadowWalkBody(perRoot: string): string {
  return `
    var roots = [document], open = 0, hosts = 0, scanned = 0, capped = 0, taken = 0;
    for (var d = 0; d <= ${SHADOW_WALK_MAX_DEPTH} && roots.length; d++) {
      // The last pass MEASURES: anything it collects is a level the depth
      // bound cut off, and nothing it collects is searched.
      var measuring = d === ${SHADOW_WALK_MAX_DEPTH};
      var next = [];
      for (var r = 0; r < roots.length; r++) {
        if (scanned >= ${SHADOW_WALK_MAX_NODES}) { capped = 1; break; }
        var els;
        try { els = roots[r].querySelectorAll('*'); } catch (e) { continue; }
        for (var i = 0; i < els.length; i++) {
          if (scanned >= ${SHADOW_WALK_MAX_NODES}) { capped = 1; break; }
          scanned += 1;
          var el = els[i], sr = null;
          try { sr = el.shadowRoot; } catch (e) { sr = null; }
          if (sr) {
            if (taken < ${SHADOW_WALK_MAX_ROOTS}) { taken += 1; next.push(sr); } else capped = 1;
          } else if (el.tagName.indexOf('-') !== -1) {
            hosts += 1;
          }
        }
      }
      if (measuring) {
        if (next.length) capped = 1;
        break;
      }
      for (var j = 0; j < next.length; j++) {
        open += 1;
        var root = next[j];
        ${perRoot}
      }
      roots = next;
    }`
}

/**
 * Resolve a `css=` selector, descending OPEN shadow roots when, and only
 * when, the document itself matched nothing.
 *
 * Light DOM WINS, always: the document query runs first and its first match
 * is returned unchanged, so every selector that worked before this walk
 * existed still resolves to the same element. What changes is the miss: a
 * selector whose element lives inside a web component's open root now finds
 * it instead of reporting that the element is not there.
 *
 * The whole selector is applied in each root rather than split across
 * boundaries. True Playwright-style piercing (one selector whose compound
 * parts span roots) needs a CSS parser in the probe body, which is out of
 * proportion to the win; applying the rule per root covers the case that
 * motivated this (the agent writes `css=#pay-btn` and the button is in a
 * component) and needs nothing taught.
 *
 * CLOSED roots are unreachable from ANY world: `element.shadowRoot` is null
 * for them and encapsulation is not world-scoped, so no walk can ever see
 * inside one. The miss report therefore carries what the walk DID see (open
 * roots searched, whether the page has custom elements at all, whether a
 * bound cut the search short) and the refusal points at `@refs`, which do
 * reach shadow content because they ride the AX tree's backendNodeIds rather
 * than the DOM tree.
 */
export function cssResolveExpression(query: string): string {
  return `(function(){
    var q = ${JSON.stringify(query)};
    var direct;
    try { direct = document.querySelectorAll(q); } catch (e) { return '${SELECTOR_INVALID}'; }
    if (direct.length) return direct[0];
    ${shadowWalkBody(
      "var found = null; try { found = root.querySelector(q); } catch (e) { found = null; } if (found) return found;",
    )}
    return '${SELECTOR_MISS}' + open + ',' + hosts + ',' + capped;
  })()`
}

/**
 * How many elements a `css=` rule matches, over the scopes the resolution
 * searched: the document, and (only when the document matched nothing, which
 * is exactly when the resolution walked) the open shadow roots. A SUPERSET of
 * what the resolution looked at, deliberately: the resolution returns at its
 * first match while the count keeps going, which is the whole point of having
 * it. Counting in the matched element's own root alone reported 1 for three
 * matches spread across two roots, retiring the ambiguity warning in the case
 * that most needs it (review round).
 *
 * Returns `{n, capped, shadow}`, never a bare number, because a count is only
 * honest with its qualifiers attached: `capped` means a bound cut the search,
 * so `n` is a FLOOR rather than a total (a page with 60 open roots reported a
 * measured-sounding 50), and `shadow` says the document matched nothing, so
 * the resolution came from a root. `shadow` is authoritative in a way asking
 * the element's own `getRootNode()` is not: it is the same document query the
 * resolution branched on, and it cannot be shadowed by page markup.
 *
 * `qExpr` is the JS expression naming the selector in the caller's scope.
 * An invalid rule THROWS out of here rather than counting 0: the caller's own
 * try then leaves the fields ABSENT, which is the honest answer (a 0 would be
 * a measured claim that the rule matches nothing). No caller can reach that:
 * an invalid rule refuses before any element exists to ask about.
 */
export function cssMatchCountExpression(qExpr: string): string {
  return `(function(q){
    var n = document.querySelectorAll(q).length;
    if (n) return { n: n, capped: 0, shadow: 0 };
    ${shadowWalkBody(
      "try { n += root.querySelectorAll(q).length; } catch (e) {}",
    )}
    return { n: n, capped: capped, shadow: 1 };
  })(${qExpr})`
}
