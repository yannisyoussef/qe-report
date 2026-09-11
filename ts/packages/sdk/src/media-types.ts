/**
 * True for `text/*`, JSON, XML, form-encoded, and any `+json` or `+xml` structured syntax.
 * Everything else is stored as opaque bytes and not redacted.
 */
export function isTextualMediaType(mediaType: string): boolean {
  const base = (mediaType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'application/x-www-form-urlencoded' ||
    base === 'application/javascript' ||
    base.endsWith('+json') ||
    base.endsWith('+xml')
  );
}
