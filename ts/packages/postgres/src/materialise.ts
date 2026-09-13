import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { BlobStoreError, isSha256, type BlobDescriptor, type BlobStore } from 'qe-report-blob-fs';
import type { RequiredBlob } from './archive.js';

/** How many blobs are copied and hashed at once; bounded, never one promise per attachment. */
export const MATERIALISE_CONCURRENCY = 4;

/**
 * Makes every required blob durable from the run directory's `attachments/<sha256>` files: each
 * is opened securely, streamed into the store, hashed and counted on the way, compared with the
 * run's declaration, and published only then. A source that changed since validation fails here,
 * before any database transaction; the store's error says how.
 */
export async function materialiseBlobs(
  store: BlobStore,
  runDirectory: string,
  required: readonly RequiredBlob[],
): Promise<BlobDescriptor[]> {
  const results: BlobDescriptor[] = new Array<BlobDescriptor>(required.length);
  if (required.length === 0) return results;
  const attachments = join(runDirectory, 'attachments');
  // As the validator does: nothing beneath an attachments entry that is not a real directory is
  // opened, so a directory swapped for a link after validation reads nothing through it.
  const kind = lstatSync(attachments, { throwIfNoEntry: false });
  if (kind === undefined || !kind.isDirectory()) {
    throw new BlobStoreError(
      'SOURCE_NOT_REGULAR',
      `the attachments directory of the run is ${kind === undefined ? 'missing' : 'not a directory'}; nothing beneath it is read`,
    );
  }
  await eachLimited(required, MATERIALISE_CONCURRENCY, async (blob, i) => {
    if (!isSha256(blob.sha256)) throw new BlobStoreError('INVALID_SHA256', 'not a hash');
    const { sha256, sizeBytes, storageKey } = await store.put({
      path: join(attachments, blob.sha256),
      sha256: blob.sha256,
      sizeBytes: blob.sizeBytes,
    });
    results[i] = { sha256, sizeBytes, storageKey };
  });
  return results;
}

/** Runs `fn` over `items` with at most `limit` in flight; the first failure rejects after the others settle. */
export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        await fn(items[i] as T, i);
      } catch (e) {
        if (!failed) {
          failed = true;
          failure = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}
