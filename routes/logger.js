// logger.js — Minimal logging utility
// Used by routes/notices.js for consistent log formatting

const logger = {
    info: (message) => {
      console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
    },
    
    warn: (message) => {
      console.warn(`[WARN] ${new Date().toISOString()} - ${message}`);
    },
    
    error: (message, error) => {
      if (error) {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error);
      } else {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
      }
    }
  };
  
  module.exports = logger;