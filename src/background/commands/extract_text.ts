import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'
import { DOC_STATUS_SNIPPET, httpStatusField } from '../docStatus'
import { GLOBAL_READ_SNIPPET, probeWorldUnavailableError, withProbeWorld } from '../worlds'

/**
 * Visible text of a page or of one region.
 *
 * Reads through CDP rather than `chrome.scripting.executeScript`, which needs
 * host permission for the origin. The debugger is already attached and needs
 * none, so this works on every site the agent can reach instead of only the
 * ones the user has separately granted.
 *
 * The read runs in the ISOLATED PROBE WORLD (#160 world discipline). It was
 * the last main-world read left after the hostile-page pass: there, a page
 * overrides `querySelector`, `innerText` or `title` and picks what the model
 * believes the page says, including the `url` and `title` that render outside
 * the untrusted fence. Fail-closed, never a main-world retry.
 *
 * A world is not enough on its own, per that module's probe-body rule: named
 * DOM properties are real DOM and follow you into it, and `Document` and
 * `HTMLFormElement` both let a named element SHADOW a built-in
 * (`<img name="body">`, `<input name="innerText">` in a form). So every
 * accessor here is called through its prototype descriptor and never looked
 * up on the object. A non-HTML root (an SVG node) reads `textContent`, since
 * `innerText` is not on its prototype at all.
 *
 * Root document only: no frame parameter, so an iframe's text is not part of
 * this answer (chrome_read_page is the frame-aware reader).
 *
 * The read answers THREE things in one evaluation, so all three describe the
 * same document at the same instant: the text, the document's own HTTP status
 * (`docStatus.ts`, #187), and how much meaning the text could not carry
 * (`TEXT_DROPPED_SNIPPET`, #190).
 *
 * STOPGAP (v0.9.0), to be removed by the selector-alignment pass: the act
 * path's `css=` resolution walks open shadow roots and this read does not, so
 * one selector can act and then fail to read. Extending the walk to here is
 * that pass's work; until then the selector-miss error NAMES the asymmetry
 * rather than letting it read as "no such element", which is the
 * investigation-starting lie this series keeps closing.
 */

interface ExtractTextArgs {
  tab_id: number
  selector?: string
  max_chars?: number
}

interface TextDropped {
  generated: number
  capped: boolean
}

interface PageText {
  found: boolean
  text: string
  url: string
  title: string
  status: number | null
  /** Null when the read found no root, and when the scan itself threw. */
  dropped: TextDropped | null
}

/**
 * Elements the loss scan will walk before it stops and says so.
 *
 * Measured 2026-08-19 on a 12,478-element Wikipedia article: the full walk
 * cost ~200ms of the USER's browser main thread, and stopping here cost
 * ~101ms. Deliberately an element count rather than a time budget: a budget
 * would adapt better but makes the answer nondeterministic, and this series
 * spent a whole pass (#180) buying determinism back.
 */
const TEXT_SCAN_CAP = 5000

/**
 * Count the meaning this read could not carry (#190).
 *
 * `innerText` returns rendered TEXT NODES, so a glyph drawn by CSS generated
 * content contributes nothing and leaves no trace. Measured live: a chess move
 * list read as `1. f6 / 2. e4 / 3. c5`, where the real moves were 1...Nf6,
 * 2...Ne4, 3...Nc5, and a block of rating stars, status pills and icon buttons
 * read as two order numbers and nothing else. The answer is not degraded, it is
 * WRONG, and nothing about its shape says so.
 *
 * Generated content ONLY, and that is a measurement, not a scope cut. The same
 * probe counted images on real pages: 267 on one Wikipedia article, 36 on BBC
 * News, which would fire a large meaningless number on most of the web. The
 * strict generated-content count instead measured 0 on example.com, Hacker News
 * and BBC News, 1 on that Wikipedia article, and 11 on the glyph fixture, so it
 * is silent on ordinary prose and loud exactly where the loss lives. Images and
 * `alt` text stay in the read's GUIDANCE, which already points at
 * chrome_read_page for attribute-borne content.
 *
 * Four filters, each measured rather than assumed:
 *
 * - `display:none` and `visibility:hidden` elements STILL report their
 *   generated content, so an element gate is required or hidden decoration
 *   inflates the count. It gates on `checkVisibilityCSS` ALONE, deliberately:
 *   `innerText` includes the text of an `opacity: 0` element (measured
 *   `"FADE  SHOWN"`), so a glyph there is lost exactly like any other, and
 *   `checkOpacity` would have skipped it. The gate mirrors what innerText
 *   itself drops, not what a human can see.
 * - The PSEUDO-element has its own box, and its computed style is already in
 *   hand: `.tip::after { content: attr(data-tip); display: none }` is the
 *   ordinary tooltip idiom and renders nothing, so it lost nothing.
 * - Text is counted by a character scan rather than pattern-matching, because
 *   `content` takes any `<image>`: `image-set(url("a.png") 1x)` carries a
 *   quoted string that is a FILENAME, and gradients, `element()` and the
 *   quote keywords carry no text at all. Only quoted runs at paren depth ZERO
 *   are text, which also keeps a literal `"(1)"` countable.
 * - `counter()` is the one text source computed style leaves unresolved, so it
 *   is detected by name.
 *
 * The loose version of this filter counted 1,102 on that same Wikipedia page.
 */
const TEXT_DROPPED_SNIPPET = `${GLOBAL_READ_SNIPPET}
  var nymTextAdds = function (content) {
    // Quoted runs OUTSIDE any function call are the text a pseudo adds.
    if (/\\bcounters?\\(/.test(content)) return true;
    var depth = 0;
    var quoted = false;
    var text = '';
    for (var c = 0; c < content.length; c++) {
      var ch = content.charAt(c);
      if (quoted) {
        if (ch === '"') { quoted = false; continue; }
        if (ch === '\\\\') { c++; continue; }
        if (depth === 0) text += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && depth > 0) depth--;
    }
    return text.replace(/\\s/g, '') !== '';
  };
  var nymTextDropped = function (root) {
    var out = { generated: 0, capped: false };
    try {
      var gcs = nymGlobal('getComputedStyle');
      if (typeof gcs !== 'function') return out;
      var all = Element.prototype.querySelectorAll.call(root, '*');
      // The ROOT itself counts: querySelectorAll returns DESCENDANTS only, and
      // a scoped read of \`#price\` whose own ::before draws the currency symbol
      // is the narrowest and most-trusted read shape there is (review round).
      var total = all.length + 1;
      out.capped = total > ${TEXT_SCAN_CAP};
      var limit = out.capped ? ${TEXT_SCAN_CAP} : total;
      var visD = Object.getOwnPropertyDescriptor(Element.prototype, 'checkVisibility');
      var canSee = visD && typeof visD.value === 'function' ? visD.value : null;
      for (var i = 0; i < limit; i++) {
        var el = i === 0 ? root : all[i - 1];
        if (canSee) {
          var visible = true;
          try { visible = canSee.call(el, { checkVisibilityCSS: true }); } catch (e) {}
          if (!visible) continue;
        }
        for (var p = 0; p < 2; p++) {
          var style = null;
          try { style = gcs.call(globalThis, el, p ? '::after' : '::before'); } catch (e) { continue; }
          if (!style) continue;
          var content = style.content;
          if (typeof content !== 'string' || content === 'none' || content === 'normal') continue;
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (!nymTextAdds(content)) continue;
          out.generated++;
        }
      }
    } catch (e) {}
    return out;
  };`

export async function execExtractText(args: unknown): Promise<CommandResult> {
  const a = args as ExtractTextArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const limit = typeof a.max_chars === 'number' && a.max_chars > 0 ? a.max_chars : 50_000
  const selectorLiteral = a.selector ? JSON.stringify(a.selector) : 'null'

  const resp = await withProbeWorld(a.tab_id, (contextId) =>
    sendCommand<{ result?: { value?: PageText }; exceptionDetails?: unknown }>(
      a.tab_id,
      'Runtime.evaluate',
      {
        expression: `(function(){
      ${DOC_STATUS_SNIPPET}
      ${TEXT_DROPPED_SNIPPET}
      const sel = ${selectorLiteral};
      const read = function (proto, name, obj) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        return d && d.get ? d.get.call(obj) : undefined;
      };
      const url = location.href;
      const rawTitle = read(Document.prototype, 'title', document);
      const title = typeof rawTitle === 'string' ? rawTitle : '';
      const status = nymDocStatus();
      const root = sel
        ? Document.prototype.querySelector.call(document, sel)
        : read(Document.prototype, 'body', document);
      if (!root) return { found: false, text: '', url: url, title: title, status: null, dropped: null };
      const raw =
        root instanceof HTMLElement
          ? read(HTMLElement.prototype, 'innerText', root)
          : read(Node.prototype, 'textContent', root);
      return {
        found: true,
        text: typeof raw === 'string' ? raw : '',
        url: url,
        title: title,
        status: status,
        dropped: nymTextDropped(root),
      };
    })()`,
        contextId,
        returnByValue: true,
      },
    ),
  )

  if (resp === null) {
    return { ok: false, status: 'error', error: probeWorldUnavailableError('the page text read') }
  }
  const value = resp.result?.value
  if (resp.exceptionDetails || !value) {
    // The read FAILED, so nothing at all was learned about the page. Until
    // 0.9.0 this fell through to "page has no readable body", which told the
    // agent the page was empty when the truth was that we never saw it.
    return {
      ok: false,
      status: 'error',
      error:
        'the page text read failed inside the page; retry, and if it repeats ' +
        'use chrome_read_page instead',
    }
  }
  if (!value.found) {
    return {
      ok: false,
      status: 'error',
      error: a.selector
        ? `selector matched no element: ${a.selector} (this read searches the ` +
          'document only, while a css= act also searches open shadow roots, so ' +
          'for a web component read with chrome_read_page or act on a css= ref)'
        : 'page has no readable body',
    }
  }
  let text = value.text
  const truncated = text.length > limit
  if (truncated) text = text.slice(0, limit)
  return {
    ok: true,
    status: 'success',
    data: {
      text,
      truncated,
      url: value.url,
      title: value.title,
      ...httpStatusField(value.status),
      ...droppedFields(value.dropped),
    },
  }
}

/**
 * The loss fields, or nothing at all.
 *
 * A zero renders no note, so it ships no key: an ordinary prose page pays
 * neither the payload nor the sentence. The cap flag rides only ALONGSIDE a
 * count, where it turns the number into a floor. A capped walk that found
 * nothing stays silent on purpose: the alternative renders "some of this page
 * was not scanned" on every large page, which is the wallpaper this count was
 * shaped to avoid.
 */
function droppedFields(dropped: TextDropped | null | undefined): Record<string, unknown> {
  const generated = dropped?.generated
  if (typeof generated !== 'number' || !Number.isInteger(generated) || generated <= 0) return {}
  return {
    text_dropped_generated: generated,
    ...(dropped?.capped === true ? { text_dropped_capped: true } : {}),
  }
}

/** Internal seams for unit tests; not part of the command's contract. */
export const __test = { TEXT_DROPPED_SNIPPET, TEXT_SCAN_CAP }
