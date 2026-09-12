export default function globalTeardown(): void {
  throw new Error('global teardown broke');
}
