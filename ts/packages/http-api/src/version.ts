/**
 * Which release this server is, as recorded by whatever packaged it.
 *
 * The application deliberately holds no version of its own. A build of this source is not a
 * release; a release is an image, a tarball or a Maven artifact made from it, and each of those
 * records the product version at the moment it was built. The container passes it in as
 * `QE_REPORT_PRODUCT_VERSION`, set from an OCI label, so `--version` reports what the image claims
 * rather than a number compiled in months earlier.
 *
 * Outside a release, there is nothing to report, and saying so is better than guessing.
 */
export const UNKNOWN_VERSION = 'unknown';

export function productVersion(env: NodeJS.ProcessEnv): string {
  const recorded = env.QE_REPORT_PRODUCT_VERSION;
  return recorded === undefined || recorded === '' ? UNKNOWN_VERSION : recorded;
}
