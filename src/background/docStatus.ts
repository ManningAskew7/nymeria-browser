import { GLOBAL_READ_SNIPPET } from './worlds'

/**
 * The HTTP status of the document a READ just read, taken from the document
 * itself (#187).
 *
 * The problem: an error PAGE commits like any other page, so `chrome_read_text`
 * on a 404 returned ordinary prose with nothing to say the load failed, and a
 * site with a soft error page turns that into a confidently wrong answer.
 *
 * Deliberately NOT statusWatch. That module is the right answer for a
 * NAVIGATION (it observes the response from the browser process, before the
 * commit, and attributes it to the command that caused it), but it is the wrong
 * shape for a read, and three measured facts decided it:
 *
 * - it needs the runtime host grant, and dies with the MV3 worker, so a read of
 *   a page loaded a minute ago usually learns nothing;
 * - a read arrives arbitrarily later than the navigation, so its record has to
 *   be JOINED back to the document, and every join has a race (a reload whose
 *   response has landed but not committed would attribute the NEW status to the
 *   OLD document a read is still reading);
 * - `PerformanceNavigationTiming` needs no grant, survives a worker recycle,
 *   needs no join at all (the entry IS the current document's), and survives a
 *   pushState with its original value, which the URL-matching join would lose.
 *
 * Read in the PROBE world, and that is what makes it trustworthy rather than
 * page-supplied. Measured 2026-08-19 against a page that overrode
 * `window.performance`, `Performance.prototype.getEntriesByType` AND
 * `PerformanceResourceTiming.prototype.responseStatus`: the main world returned
 * the forged 200, the probe world returned the true 404. `performance` is read
 * through `nymGlobal` rather than bare for the WindowProperties reason that
 * snippet documents.
 *
 * Every failure answers null and the caller omits the field: absent is UNKNOWN,
 * never a claim the load was fine. That includes a Chrome without
 * `responseStatus` (feature-detected through the descriptor) and the spec's own
 * `0`, which means "not available", not "zero".
 */
export const DOC_STATUS_SNIPPET = `${GLOBAL_READ_SNIPPET}
  var nymDocStatus = function () {
    try {
      var perf = nymGlobal('performance');
      if (!perf) return null;
      var g = Object.getOwnPropertyDescriptor(Performance.prototype, 'getEntriesByType');
      var entriesOf = g && typeof g.value === 'function' ? g.value : null;
      if (!entriesOf) return null;
      var entries = entriesOf.call(perf, 'navigation');
      if (!entries || !entries.length) return null;
      var d = Object.getOwnPropertyDescriptor(PerformanceResourceTiming.prototype, 'responseStatus');
      if (!d || !d.get) return null;
      var status = d.get.call(entries[0]);
      return typeof status === 'number' ? status : null;
    } catch (e) {
      return null;
    }
  };`

/** Standalone form, for a reader that has no expression of its own to carry it. */
export const DOC_STATUS_EXPRESSION = `(function(){
  ${DOC_STATUS_SNIPPET}
  return { http_status: nymDocStatus() };
})()`

/**
 * The payload field for a document status, or `{}` when it cannot be known.
 *
 * One producer so both readers cannot drift on what counts as knowing. The
 * range check is the honest floor: `0` is the spec's "not available" and
 * anything outside 100..599 is not a status at all, and either would render a
 * note about a response nobody observed.
 */
export function httpStatusField(value: unknown): Record<string, number> {
  const known =
    typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
  return known ? { http_status: value as number } : {}
}
