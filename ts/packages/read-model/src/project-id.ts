/** Rejects a partition key that cannot partition: a programming error, not an ingestion problem. */
export function checkProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
  }
}
