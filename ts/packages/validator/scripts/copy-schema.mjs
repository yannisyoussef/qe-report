// The protocol schema is the source of truth in protocol/schema; the validator ships a copy.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', '..', '..', 'protocol', 'schema', 'event.schema.json');
const target = join(here, '..', 'schema', 'event.schema.json');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
