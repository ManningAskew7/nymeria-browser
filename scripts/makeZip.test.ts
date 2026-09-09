/**
 * The release zip's two properties, exercised on the real script
 * (`scripts/make_zip.py`, which `scripts/package.sh` calls) over a temp tree.
 *
 * It is tested here rather than in CI-only shell because both properties are
 * silent when they break: an unstable digest only shows up as `nymeria browser
 * configure` refusing to stage a re-published release on some other host, and
 * a leaked credential only shows up after it is public.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Vitest runs from the project root, which is where the script lives. */
const SCRIPT = resolve(process.cwd(), 'scripts/make_zip.py')

const workspaces: string[] = []

/** A throwaway source tree shaped like a dist/ build. */
function stageTree(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'nymeria-zip-'))
  workspaces.push(dir)
  const src = join(dir, 'dist')
  mkdirSync(join(src, 'assets'), { recursive: true })
  writeFileSync(join(src, 'manifest.json'), '{"version":"0.29.0"}\n')
  writeFileSync(join(src, 'assets', 'background.js'), 'console.log("hi")\n')
  writeFileSync(join(src, 'index.html'), '<!doctype html>\n')
  for (const [rel, body] of Object.entries(extra)) {
    writeFileSync(join(src, rel), body)
  }
  return dir
}

interface RunResult {
  status: number
  stderr: string
}

function runMakeZip(dir: string, out: string): RunResult {
  try {
    execFileSync('python3', [SCRIPT, join(dir, 'dist'), join(dir, out), 'nymeria-browser-v0.29.0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stderr?: string }
    return { status: failure.status ?? -1, stderr: failure.stderr ?? '' }
  }
}

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true })
})

describe('make_zip.py', () => {
  it('produces the same bytes from the same tree, whatever the mtimes and modes are', () => {
    // The backend pins EXTENSION_RELEASE_SHA256, so this is the property that
    // lets a release be re-run (or a tag re-pushed) without breaking
    // `nymeria browser configure` on every host that has not cached the old
    // zip. ZipFile.write() stores each member's filesystem mtime and mode,
    // which a fresh checkout, a rebuild, or a touch all change.
    const dir = stageTree()
    expect(runMakeZip(dir, 'first.zip').status).toBe(0)

    const shifted = new Date('2001-02-03T04:05:06Z')
    utimesSync(join(dir, 'dist', 'manifest.json'), shifted, shifted)
    utimesSync(join(dir, 'dist', 'assets', 'background.js'), shifted, shifted)
    chmodSync(join(dir, 'dist', 'index.html'), 0o600)

    expect(runMakeZip(dir, 'second.zip').status).toBe(0)

    expect(digest(join(dir, 'second.zip'))).toBe(digest(join(dir, 'first.zip')))
  })

  it('still notices a real content change (the digest is not simply constant)', () => {
    const dir = stageTree()
    runMakeZip(dir, 'first.zip')
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><!-- changed -->\n')

    runMakeZip(dir, 'second.zip')

    expect(digest(join(dir, 'second.zip'))).not.toBe(digest(join(dir, 'first.zip')))
  })

  it('refuses to build when the tree holds a baked config.json, naming it', () => {
    // The file the whole denylist exists for: `nymeria browser configure`
    // bakes one into a staged copy of this extension, and it carries a full
    // Nymeria account token. The zips go to a PUBLIC GitHub Release.
    const dir = stageTree({ 'config.json': '{"baseUrl":"https://x.test","token":"nym_secret"}' })

    const result = runMakeZip(dir, 'out.zip')

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('config.json')
    expect(() => readFileSync(join(dir, 'out.zip'))).toThrow()
  })

  it.each([['secrets.json'], ['.env'], ['rig.pem'], ['id_ed25519'], ['api.key']])(
    'refuses to build when the tree holds %s',
    (name) => {
      const dir = stageTree({ [name]: 'secret' })

      const result = runMakeZip(dir, 'out.zip')

      expect(result.status).toBe(3)
      expect(result.stderr).toContain(name)
    },
  )

  it('names every offending file, not just the first', () => {
    const dir = stageTree({ 'config.json': '{}', '.env': 'TOKEN=x' })

    const result = runMakeZip(dir, 'out.zip')

    expect(result.stderr).toContain('config.json')
    expect(result.stderr).toContain('.env')
  })

  it('packages an ordinary build under one top-level folder', () => {
    const dir = stageTree()

    expect(runMakeZip(dir, 'out.zip').status).toBe(0)

    const names = execFileSync(
      'python3',
      ['-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', join(dir, 'out.zip')],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
    // Depth-first, each level sorted: the order is part of what makes the
    // digest stable, so it is asserted rather than sorted before comparing.
    expect(names).toEqual([
      'nymeria-browser-v0.29.0/index.html',
      'nymeria-browser-v0.29.0/manifest.json',
      'nymeria-browser-v0.29.0/assets/background.js',
    ])
  })
})
