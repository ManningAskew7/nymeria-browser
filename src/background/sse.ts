export function parseSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let rest = buffer
  while (true) {
    const idx = rest.indexOf('\n\n')
    if (idx === -1) break
    frames.push(rest.slice(0, idx))
    rest = rest.slice(idx + 2)
  }
  return { frames, rest }
}

export function frameToData(frame: string): string | null {
  const lines = frame.split('\n')
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  return dataLines.length ? dataLines.join('\n') : null
}
