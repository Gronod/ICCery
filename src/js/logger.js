const { invoke } = window.__TAURI__.core;

/**
 * Lightweight frontend logger that writes to both the browser console and the
 * rotating host application log (iccery.log) via Tauri command `log_frontend_message`.
 */
export const logger = {
  async log(level, message, context = null) {
    const formattedMsg = message instanceof Error ? `${message.message}\n${message.stack || ''}` : String(message);

    // DevTools console output
    if (level === 'error') {
      console.error(`[${context || 'Frontend'}]`, formattedMsg);
    } else if (level === 'warn' || level === 'warning') {
      console.warn(`[${context || 'Frontend'}]`, formattedMsg);
    } else if (level === 'debug') {
      console.debug(`[${context || 'Frontend'}]`, formattedMsg);
    } else {
      console.log(`[${context || 'Frontend'}]`, formattedMsg);
    }

    // Forward to backend log
    try {
      await invoke('log_frontend_message', {
        level: level.toLowerCase(),
        message: formattedMsg,
        context: context || null,
      });
    } catch (_) {
      // Avoid recursion or noise if invoke fails
    }
  },

  error(message, context) {
    return this.log('error', message, context);
  },

  warn(message, context) {
    return this.log('warn', message, context);
  },

  info(message, context) {
    return this.log('info', message, context);
  },

  debug(message, context) {
    return this.log('debug', message, context);
  }
};
