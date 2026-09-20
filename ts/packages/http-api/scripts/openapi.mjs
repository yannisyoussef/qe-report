import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateOpenApi } from '../dist/index.js';

/**
 * Reads the built package, so run it after `pnpm build`. Writes the committed OpenAPI contract from the route table and the protocol schema, or with
 * `--check` fails when the committed file is not exactly what generation produces.
 */
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const protocol = JSON.parse(readFileSync(`${repository}protocol/schema/event.schema.json`, 'utf8'));
const target = `${repository}openapi/qe-report-api-v1.json`;
const generated = `${JSON.stringify(generateOpenApi(protocol), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    committed = '';
  }
  if (committed !== generated) {
    process.stderr.write(
      'openapi/qe-report-api-v1.json is not what the route table generates; run `pnpm --filter qe-report-http-api openapi` and commit it\n',
    );
    process.exit(1);
  }
  process.stdout.write('openapi/qe-report-api-v1.json matches the route table\n');
} else {
  writeFileSync(target, generated);
  process.stdout.write(`wrote ${target}\n`);
}
