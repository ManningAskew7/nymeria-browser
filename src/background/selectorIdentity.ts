/**
 * Which candidate of a comma-separated selector list actually answered.
 *
 * Shared by BOTH readers rather than twinned: `chrome_read_text` scopes with a
 * `selector` and `chrome_read_page` with the same string, so a selector list
 * means the same thing on each, and #193's complaint ("I cannot tell which of
 * the three produced this") lands identically on the reader an agent uses to
 * ACT. One snippet means the rule cannot drift between them.
 */

/**
 * A defensive multi-selector read (`.moveList, wc-simple-move-list,
 * .move-list`) is the ordinary shape against an SPA whose class names move
 * between releases, and the first real-world drive wrote exactly that and
 * could not tell which candidate produced the text (#193). It matters most
 * when the candidates differ in FIDELITY: with #190's figurine loss in play,
 * "which container did I sample" decides whether the piece letters could ever
 * have been there.
 *
 * The split scans at paren/bracket depth zero outside quotes, because a list
 * can carry commas inside `:is(a, b)`, `:not(a, b)` and `[x="a,b"]`, and a
 * naive split would report a fragment that is not a selector at all. A part
 * that throws in `matches()` is skipped, so the worst case is NO identity,
 * never a wrong one. EVERY part the element satisfies is reported: a list can
 * name one element three ways, and choosing among them would be a claim the
 * DOM does not support.
 */
export const SELECTOR_IDENTITY_SNIPPET = `
  var nymSelectorParts = function (sel) {
    var parts = [];
    var buf = '';
    var depth = 0;
    var quote = '';
    for (var i = 0; i < sel.length; i++) {
      var ch = sel[i];
      if (quote) {
        if (ch === '\\\\') { buf += ch + (sel[i + 1] || ''); i++; continue; }
        if (ch === quote) quote = '';
        buf += ch;
        continue;
      }
      if (ch === '\\\\') { buf += ch + (sel[i + 1] || ''); i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    parts.push(buf);
    return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
  };
  var nymSelectorIdentity = function (root, sel) {
    try {
      var parts = nymSelectorParts(sel);
      if (parts.length < 2) return null;
      var hit = [];
      for (var i = 0; i < parts.length; i++) {
        try {
          if (Element.prototype.matches.call(root, parts[i])) hit.push(parts[i]);
        } catch (e) {}
      }
      // Every candidate matching is the same non-answer as a single selector:
      // the identity would restate the caller's whole argument and
      // distinguish nothing (review round).
      if (!hit.length || hit.length === parts.length) return null;
      return hit.join(', ');
    } catch (e) { return null; }
  };`
