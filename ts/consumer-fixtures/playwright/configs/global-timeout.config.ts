import { global } from './global.js';

export default global('slow.spec.ts', { globalTimeout: 6_000, workers: 1 });
