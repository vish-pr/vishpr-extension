// Simple Logger for Browser Extension
// Logs all steps, LLM calls, tool calls, and actions

const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

class Logger {
  constructor(logLevel = LogLevel.INFO, storageKey = 'extension_logs') {
    this.logLevel = logLevel;
    this.storageKey = storageKey;
    this.logs = [];
    this.maxLogsInMemory = 1000;
  }

  getLevelString(level) {
    switch (level) {
      case LogLevel.DEBUG: return 'DEBUG';
      case LogLevel.INFO: return 'INFO';
      case LogLevel.WARN: return 'WARN';
      case LogLevel.ERROR: return 'ERROR';
      default: return 'UNKNOWN';
    }
  }

  getCodeLocation() {
    try {
      const stack = new Error().stack;
      const stackLines = stack.split('\n');
      // Find the first stack frame that's not from logger.js
      for (let i = 0; i < stackLines.length; i++) {
        const line = stackLines[i];
        if (line.includes('.js') && !line.includes('logger.js')) {
          // Extract file:line from the stack trace
          const match = line.match(/([^\/\\]+\.js):(\d+):(\d+)/);
          if (match) {
            return `${match[1]}:${match[2]}`;
          }
        }
      }
    } catch (error) {
      // Fallback if stack parsing fails
      return 'unknown';
    }
    return 'unknown';
  }

  async writeToStorage(entry) {
    const location = entry.location || 'unknown';
    const logLine = `${entry.message}${entry.data ? ` | ${JSON.stringify(entry.data)}` : ''}`;
    const fileLogLine = `[${entry.timestamp}] ${this.getLevelString(entry.level)} - [${location}] ${logLine}`;

    // Store in memory
    this.logs.push(fileLogLine);

    // Keep only recent logs in memory
    if (this.logs.length > this.maxLogsInMemory) {
      this.logs = this.logs.slice(-this.maxLogsInMemory);
    }

    // Output to console with truncation
    const maxLength = 50000;
    const consoleOutput = fileLogLine.length > maxLength
      ? `${fileLogLine.substring(0, maxLength / 2)}...${fileLogLine.substring(fileLogLine.length - maxLength / 2)}`
      : fileLogLine;
    console.log(consoleOutput);

    // Store to chrome.storage.local (async, non-blocking)
    try {
      const storageData = await this.getStorageData();
      storageData.push(fileLogLine);

      // Keep only recent logs in storage (last 500 entries)
      if (storageData.length > 500) {
        storageData.splice(0, storageData.length - 500);
      }

      await chrome.storage.local.set({ [this.storageKey]: storageData });
    } catch (error) {
      console.error('Failed to write to storage:', error);
    }
  }

  async getStorageData() {
    try {
      const result = await chrome.storage.local.get([this.storageKey]);
      return result[this.storageKey] || [];
    } catch (error) {
      console.error('Failed to read from storage:', error);
      return [];
    }
  }

  log(level, message, data) {
    if (level < this.logLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      location: this.getCodeLocation()
    };

    this.writeToStorage(entry);
  }

  debug(message, data) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message, data) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message, data) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message, data) {
    this.log(LogLevel.ERROR, message, data);
  }

  setLogLevel(level) {
    this.logLevel = level;
  }

  // Get all stored logs from memory
  getLogs() {
    return [...this.logs];
  }

  // Clear logs from memory
  clearLogs() {
    this.logs = [];
  }

  // Get logs as a single string
  getLogsAsString() {
    return this.logs.join('\n');
  }

  // Download logs from storage
  async downloadLogsFromStorage() {
    try {
      const storageLogs = await this.getStorageData();
      const logs = storageLogs.join('\n');
      const blob = new Blob([logs], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `extension-debug-${new Date().toISOString()}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download logs:', error);
    }
  }

  // Get logs from storage
  async getLogsFromStorage() {
    try {
      return await this.getStorageData();
    } catch (error) {
      console.error('Failed to get logs from storage:', error);
      return [];
    }
  }

  // Clear logs from storage
  async clearLogsFromStorage() {
    try {
      await chrome.storage.local.remove([this.storageKey]);
      console.log('Logs cleared from storage');
    } catch (error) {
      console.error('Failed to clear logs from storage:', error);
    }
  }

  // Clear both memory and storage
  async clearAllLogs() {
    this.clearLogs();
    await this.clearLogsFromStorage();
  }
}

// Create a default logger instance
const logger = new Logger(LogLevel.DEBUG, 'extension_logs');

// Export both the class and the default instance
export { Logger, LogLevel, logger };
export default logger;
