import type { CommandResult } from '../../shared/types'

/**
 * Reload the extension from disk: the dev loop's missing last step.
 *
 * The operator's setup auto-pulls and rebuilds the unpacked extension on
 * disk, but Chrome only re-reads an unpacked extension when something calls
 * `chrome.runtime.reload()` (or a human clicks refresh at
 * chrome://extensions). This command is that call, made remotely, so an
 * agent can finish a deploy end to end.
 *
 * ACK FIRST, RELOAD SECOND. The reload kills this service worker, and a dead
 * worker cannot POST a result, so the executor returns immediately and
 * schedules the reload on a fixed delay long enough for the result POST to
 * complete. The delay is a race by construction; losing it costs only the
 * ack (the backend reports a transport timeout while the reload proceeds),
 * never the reload.
 *
 * What survives and what does not: stored config (`chrome.storage`) and
 * permission grants survive, and the SSE connection re-establishes itself
 * (backend dispatch already rides a 75s post-disconnect grace). In-flight
 * commands die with the worker, every debugger attachment is released
 * (banner clears, held dialogs are dropped), and buffered console/network
 * history is gone. And the one real failure mode is out of our hands: a
 * BROKEN build on disk fails to load, and nothing can remotely recover
 * that; the human reloads at chrome://extensions.
 */

/** Long enough for the result POST to win; short enough to feel immediate. */
export const RELOAD_DELAY_MS = 2_500

export async function execReloadExtension(): Promise<CommandResult> {
  const version = chrome.runtime.getManifest?.()?.version ?? 'unknown'
  setTimeout(() => chrome.runtime.reload(), RELOAD_DELAY_MS)
  return {
    ok: true,
    status: 'success',
    data: {
      reloading: true,
      version_before: version,
      note:
        'reloading the extension from disk in ~2.5s. The connection drops and ' +
        're-establishes itself; wait ~10 seconds before the next chrome_* ' +
        'call. Driving state resets: tabs are released and in-flight ' +
        'commands are lost.',
    },
  }
}
