import type { FullResult, Reporter, TestError } from '@playwright/test/reporter';
import { writeFileSync } from 'node:fs';

/**
 * Records what Playwright itself concluded, so the consumer tests can compare the derived
 * protocol verdict with the runner's own final status. Not part of the reporter under test.
 */
export default class StatusProbe implements Reporter {
  private readonly errors: string[] = [];
  private readonly file: string;

  constructor(options: { file: string }) {
    this.file = options.file;
  }

  onError(error: TestError): void {
    this.errors.push((error.message ?? error.value ?? '').split('\n')[0] ?? '');
  }

  onEnd(result: FullResult): void {
    writeFileSync(this.file, JSON.stringify({ status: result.status, errors: this.errors }));
  }

  printsToStdio(): boolean {
    return false;
  }
}
