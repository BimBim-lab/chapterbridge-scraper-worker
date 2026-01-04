import pino from 'pino';

export const logger = pino.default({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino/file',
    options: { destination: 1 }
  },
  formatters: {
    level: (label: string) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.default.stdTimeFunctions.isoTime,
});

export default logger;
