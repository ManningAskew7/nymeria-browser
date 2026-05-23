const PREFIX = '[Nymeria-Browser]'

class Logger {
  private enabled: boolean
  private prefix: string

  constructor(prefix: string = PREFIX, enabled: boolean = true) {
    this.prefix = prefix
    this.enabled = enabled
  }

  log(...args: unknown[]): void {
    if (this.enabled) console.log(this.prefix, ...args)
  }

  error(...args: unknown[]): void {
    console.error(this.prefix, '[ERROR]', ...args)
  }

  warn(...args: unknown[]): void {
    if (this.enabled) console.warn(this.prefix, '[WARN]', ...args)
  }

  debug(...args: unknown[]): void {
    if (this.enabled) console.debug(this.prefix, '[DEBUG]', ...args)
  }

  info(...args: unknown[]): void {
    if (this.enabled) console.info(this.prefix, '[INFO]', ...args)
  }

  createChild(childPrefix: string): Logger {
    return new Logger(`${this.prefix} [${childPrefix}]`, this.enabled)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }
}

export const logger = new Logger()
export const backgroundLogger = new Logger(`${PREFIX} [bg]`)
export const popupLogger = new Logger(`${PREFIX} [popup]`)

export default Logger
