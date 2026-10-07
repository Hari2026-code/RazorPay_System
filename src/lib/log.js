// Console log of everything the service does: one line per action, IST time, optional details.
// Never pass secrets or card data here: no key secret, no signatures.
import { isoIST } from './time.js'

const COLORS = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' }
const RESET = '\x1b[0m'
const useColor = process.stdout.isTTY

function write(level, action, details) {
  const tag = action.padEnd(18)
  const head = `${isoIST()}  ${useColor ? COLORS[level] : ''}${tag}${useColor ? RESET : ''}`
  const line = details === undefined ? head : `${head}  ${JSON.stringify(details)}`
  ;(level === 'error' ? console.error : console.log)(line)
}

export const log = {
  info: (action, details) => write('info', action, details),
  ok: (action, details) => write('ok', action, details),
  warn: (action, details) => write('warn', action, details),
  error: (action, details) => write('error', action, details),
}
