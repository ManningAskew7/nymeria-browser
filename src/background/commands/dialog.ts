import type { CommandResult } from '../../shared/types'
import { answerStandingDialog, describeResolution } from '../dialogs'
import { isAttached } from '../debuggerSession'

interface DialogArgs {
  tab_id: number
  action: 'accept' | 'dismiss'
  prompt_text?: string
}

/**
 * Answer the standing JS dialog the extension owns on this tab (#169).
 *
 * Ownership comes from `Page` being enabled on every attach: a dialog raised
 * while the agent is driving is recorded by `dialogs.ts` and held for up to
 * its grace window, and this command answers it from the BROWSER process, so
 * the suspended renderer is irrelevant. What it cannot do, ever, is answer a
 * dialog raised while no attach was live: a reactive enable does not own a
 * dialog already standing (measured), so those cases return an honest
 * explanation instead of a timeout, and the recovery matrix in SKILL.md
 * still applies to them.
 */
export async function execDialog(args: unknown): Promise<CommandResult> {
  const a = args as DialogArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (a.action !== 'accept' && a.action !== 'dismiss') {
    return { ok: false, status: 'error', error: "action must be 'accept' or 'dismiss'" }
  }
  const result = await answerStandingDialog(
    a.tab_id,
    a.action === 'accept',
    a.prompt_text ?? undefined,
  )
  switch (result.outcome) {
    case 'answered':
      return {
        ok: true,
        status: 'success',
        data: {
          action: a.action,
          dialog: { type: result.dialog.type, message: result.dialog.message },
        },
      }
    case 'already-resolved':
      return {
        ok: false,
        status: 'error',
        error:
          `no dialog is standing on this tab: the last one, a ${result.last.type} ` +
          `("${result.last.message}"), was ${describeResolution(result.last)}. ` +
          'Nothing was sent.',
      }
    case 'none':
      return {
        ok: false,
        status: 'error',
        error:
          'no dialog is standing on this tab. Dialogs are owned and answerable only ' +
          'while the extension is attached (from the first chrome_* command on the ' +
          'tab until shortly after the last); one raised outside that window can ' +
          `only be cleared by the user or by closing the tab.${
            isAttached(a.tab_id)
              ? ''
              : ' This tab is not currently attached, so if a dialog is on screen now, it is that case.'
          } Nothing was sent.`,
      }
    case 'failed':
      return {
        ok: false,
        status: 'error',
        error:
          `answering the ${result.dialog.type} ("${result.dialog.message}") failed: ` +
          `${result.error}. If it is no longer on screen, the user likely answered ` +
          'it first; re-read the page to see where things stand.',
      }
  }
}
