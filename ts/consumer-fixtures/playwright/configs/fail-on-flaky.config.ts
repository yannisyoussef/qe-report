import { base } from './base.js';

/** The runner's own policy fails the invocation for a flaky test that finally passed. */
export default base({ failOnFlakyTests: true, retries: 1, projects: [{ name: 'desktop' }] });
