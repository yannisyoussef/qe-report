import { base } from './base.js';

/** Reporter options win over the QE_REPORT_* environment variables. */
export default base({
  reporter: [
    [
      'qe-report-playwright',
      {
        dir: process.env.OPTIONS_DIR,
        runId: 'run-from-options',
        sessionId: 'session-from-options',
      },
    ],
    ['dot'],
  ],
  projects: [{ name: 'desktop' }],
});
