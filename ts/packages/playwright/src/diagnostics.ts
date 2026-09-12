import { Redactor } from 'qe-report-sdk';

/**
 * Problems of the reporter itself, printed once per distinct key on standard error. Reporting
 * never throws into Playwright, so this is the only place a problem becomes visible. Every line
 * passes the same redaction as the run itself: an error text can carry a secret.
 */
export class Diagnostics {
  private static readonly MAX_KEYS = 50;
  private readonly seen = new Set<string>();
  private readonly write: (line: string) => void;
  private readonly redactor = Redactor.defaults();
  private suppressed = false;

  constructor(write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
    this.write = write;
  }

  once(key: string, message: string): void {
    if (this.seen.has(key)) return;
    if (this.seen.size >= Diagnostics.MAX_KEYS) {
      if (!this.suppressed) {
        this.suppressed = true;
        this.write('qe-report-playwright: further problems of this run are not printed');
      }
      return;
    }
    this.seen.add(key);
    this.write(`qe-report-playwright: ${this.redactor.redactText(message)}`);
  }

  get count(): number {
    return this.seen.size;
  }
}
