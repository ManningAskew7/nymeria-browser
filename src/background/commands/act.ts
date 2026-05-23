import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'
import { resolve as resolveRef } from '../snapshotRefs'

interface ActArgs {
  tab_id: number
  target: string
  method: 'click' | 'fill' | 'select' | 'hover' | 'check' | 'uncheck' | 'scroll_into_view'
  value?: string
}

/**
 * Resolve `target` to a CDP Runtime objectId.
 *
 * `@e5` -> look up backendNodeId in snapshot cache, DOM.resolveNode -> objectId
 * `css=…` -> Runtime.evaluate(document.querySelector(…))
 * `xpath=…` -> Runtime.evaluate(document.evaluate(…))
 */
async function resolveTarget(tabId: number, target: string): Promise<{ objectId: string | null; error?: string }> {
  if (target.startsWith('@')) {
    const backendNodeId = resolveRef(tabId, target)
    if (backendNodeId == null) {
      return { objectId: null, error: `unknown ref ${target} (re-snapshot to refresh)` }
    }
    const resp = await sendCommand<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', {
      backendNodeId,
    })
    return { objectId: resp.object.objectId }
  }
  if (target.startsWith('css=')) {
    const selector = target.slice(4)
    const evald = await sendCommand<{ result: { objectId?: string; subtype?: string } }>(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    })
    if (!evald.result.objectId || evald.result.subtype === 'null') {
      return { objectId: null, error: `css selector matched no element: ${selector}` }
    }
    return { objectId: evald.result.objectId }
  }
  if (target.startsWith('xpath=')) {
    const xpath = target.slice(6)
    const evald = await sendCommand<{ result: { objectId?: string; subtype?: string } }>(tabId, 'Runtime.evaluate', {
      expression: `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
      returnByValue: false,
    })
    if (!evald.result.objectId || evald.result.subtype === 'null') {
      return { objectId: null, error: `xpath matched no element: ${xpath}` }
    }
    return { objectId: evald.result.objectId }
  }
  return { objectId: null, error: `target must start with @, css=, or xpath= — got: ${target.slice(0, 40)}` }
}

async function callOn(tabId: number, objectId: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const r = await sendCommand<{ result: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((v) => ({ value: v })),
    returnByValue: true,
    awaitPromise: true,
  })
  return r.result.value
}

export async function execAct(args: unknown): Promise<CommandResult> {
  const a = args as ActArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }

  const { objectId, error } = await resolveTarget(a.tab_id, a.target)
  if (!objectId) return { ok: false, status: 'error', error: error ?? 'unresolved target' }

  try {
    switch (a.method) {
      case 'click': {
        // Scroll into view first to avoid hidden-element click failures.
        await callOn(a.tab_id, objectId, 'function(){ this.scrollIntoView({block: "center", inline: "center"}); }')
        await callOn(a.tab_id, objectId, 'function(){ this.click(); }')
        return { ok: true, status: 'success', data: { action: 'click', target: a.target } }
      }
      case 'hover': {
        await callOn(a.tab_id, objectId, 'function(){ this.dispatchEvent(new MouseEvent("mouseover", {bubbles:true})); this.dispatchEvent(new MouseEvent("mouseenter", {bubbles:true})); }')
        return { ok: true, status: 'success', data: { action: 'hover', target: a.target } }
      }
      case 'fill': {
        if (a.value == null) return { ok: false, status: 'error', error: 'fill requires value' }
        await callOn(
          a.tab_id,
          objectId,
          `function(v){
            this.focus();
            const proto = Object.getPrototypeOf(this);
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(this, v); else this.value = v;
            this.dispatchEvent(new Event('input', {bubbles: true}));
            this.dispatchEvent(new Event('change', {bubbles: true}));
          }`,
          [a.value],
        )
        return { ok: true, status: 'success', data: { action: 'fill', target: a.target } }
      }
      case 'select': {
        if (a.value == null) return { ok: false, status: 'error', error: 'select requires value' }
        await callOn(
          a.tab_id,
          objectId,
          `function(v){
            this.value = v;
            this.dispatchEvent(new Event('input', {bubbles: true}));
            this.dispatchEvent(new Event('change', {bubbles: true}));
          }`,
          [a.value],
        )
        return { ok: true, status: 'success', data: { action: 'select', target: a.target } }
      }
      case 'check':
      case 'uncheck': {
        const want = a.method === 'check'
        await callOn(
          a.tab_id,
          objectId,
          `function(want){
            if (this.checked !== want) {
              this.checked = want;
              this.dispatchEvent(new Event('change', {bubbles: true}));
            }
          }`,
          [want],
        )
        return { ok: true, status: 'success', data: { action: a.method, target: a.target } }
      }
      case 'scroll_into_view': {
        await callOn(
          a.tab_id,
          objectId,
          'function(){ this.scrollIntoView({block: "center", inline: "center", behavior: "instant"}); }',
        )
        return { ok: true, status: 'success', data: { action: 'scroll_into_view', target: a.target } }
      }
      default:
        return { ok: false, status: 'error', error: `unknown method: ${String(a.method)}` }
    }
  } catch (e) {
    return { ok: false, status: 'error', error: `act failed: ${String(e)}` }
  }
}

export const __test = { resolveTarget }
