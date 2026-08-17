import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'
import { probeWorldUnavailableError, withProbeWorld } from '../worlds'

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

interface PageText {
  found: boolean
  text: string
  url: string
  title: string
}

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
      const sel = ${selectorLiteral};
      const read = function (proto, name, obj) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        return d && d.get ? d.get.call(obj) : undefined;
      };
      const url = location.href;
      const rawTitle = read(Document.prototype, 'title', document);
      const title = typeof rawTitle === 'string' ? rawTitle : '';
      const root = sel
        ? Document.prototype.querySelector.call(document, sel)
        : read(Document.prototype, 'body', document);
      if (!root) return { found: false, text: '', url: url, title: title };
      const raw =
        root instanceof HTMLElement
          ? read(HTMLElement.prototype, 'innerText', root)
          : read(Node.prototype, 'textContent', root);
      return {
        found: true,
        text: typeof raw === 'string' ? raw : '',
        url: url,
        title: title,
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
    data: { text, truncated, url: value.url, title: value.title },
  }
}
