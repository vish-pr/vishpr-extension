const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class Logger {
  constructor(logLevel = LogLevel.INFO, storageKey = 'extension_logs') {
    this.logLevel = logLevel;
    this.storageKey = storageKey;
  }

  getCodeLocation() {
    try {
      const lines = new Error().stack.split('\n');
      for (const line of lines) {
        if (line.includes('.js') && !line.includes('logger.js')) {
          const match = line.match(/([^\/\\]+\.js):(\d+)/);
          if (match) return `${match[1]}:${match[2]}`;
        }
      }
    } catch {}
    return 'unknown';
  }

  async log(level, message, data) {
    if (level < this.logLevel) return;
    const ts = new Date().toISOString();
    const loc = this.getCodeLocation();
    const prefix = `[${ts}] ${LEVEL_NAMES[level]} - [${loc}]`;
    const logLine = `${prefix} ${message}${data ? ` | ${JSON.stringify(data)}` : ''}`;
    let output = data ? `${prefix} ${message}\n${JSON.stringify(data, null, 2)}` : `${prefix} ${message}`;
    if (output.length > 50000) output = output.substring(0, 25000) + '...' + output.substring(output.length - 25000);
    const consoleMethods = [console.debug, console.info, console.warn, console.error];
    consoleMethods[level](output);
    try {
      const result = await chrome.storage.local.get([this.storageKey]);
      const logs = result[this.storageKey] || [];
      logs.push(logLine);
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      await chrome.storage.local.set({ [this.storageKey]: logs });
    } catch (e) {
      console.error('Failed to persist log to storage:', e.message);
    }
  }

  debug(message, data) { this.log(LogLevel.DEBUG, message, data); }
  info(message, data) { this.log(LogLevel.INFO, message, data); }
  warn(message, data) { this.log(LogLevel.WARN, message, data); }
  error(message, data) { this.log(LogLevel.ERROR, message, data); }
}

const logger = new Logger(LogLevel.DEBUG, 'extension_logs');
export { logger };
export default logger;
