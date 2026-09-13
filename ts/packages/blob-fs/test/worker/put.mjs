// One writer process: puts the given source and prints the outcome as JSON. Runs the built dist.
import { FileBlobStore } from '../../dist/index.js';

const [root, path, sha256, sizeBytes] = process.argv.slice(2);
try {
  const result = await new FileBlobStore(root).put({ path, sha256, sizeBytes: Number(sizeBytes) });
  process.stdout.write(JSON.stringify(result));
} catch (e) {
  // The outcome travels as JSON either way; a non-zero exit would hide it behind execFile's error.
  process.stdout.write(JSON.stringify({ error: e.code ?? String(e) }));
}
