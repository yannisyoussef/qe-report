import { join } from 'node:path';
import { root } from './base.js';
import { global } from './global.js';

export default global('pass.spec.ts', {
  globalSetup: join(root, 'tests', 'global', 'setup-fails.ts'),
});
