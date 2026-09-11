import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveConfig } from '../src/config.js';

const cwd = '/work/project';

describe('resolveConfig', () => {
  it('defaults to an enabled run of its own under qe-report', () => {
    const c = resolveConfig(undefined, { env: {}, cwd });
    expect(c.enabled).toBe(true);
    expect(c.dir).toBe(resolve(cwd, 'qe-report'));
    expect(c.runIdGenerated).toBe(true);
    expect(c.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(c.sessionId).toMatch(/^pw-\d+-[0-9a-f]{8}$/u);
    expect(c.notes).toEqual([]);
  });

  it('reads the environment and lets options win over it', () => {
    const env = {
      QE_REPORT_ENABLED: 'false',
      QE_REPORT_DIR: 'out/qe',
      QE_REPORT_RUN_ID: 'run-env',
      QE_REPORT_SESSION_ID: 'session-env',
    };
    const fromEnv = resolveConfig(undefined, { env, cwd });
    expect(fromEnv.enabled).toBe(false);
    expect(fromEnv.dir).toBe(resolve(cwd, 'out/qe'));
    expect(fromEnv.runId).toBe('run-env');
    expect(fromEnv.runIdGenerated).toBe(false);
    expect(fromEnv.sessionId).toBe('session-env');
    const fromOptions = resolveConfig(
      { enabled: true, dir: '/abs/dir', runId: 'run-opt', sessionId: 'session-opt' },
      { env, cwd },
    );
    expect(fromOptions.enabled).toBe(true);
    expect(fromOptions.dir).toBe('/abs/dir');
    expect(fromOptions.runId).toBe('run-opt');
    expect(fromOptions.sessionId).toBe('session-opt');
  });

  it('names a shard in a generated session id', () => {
    const c = resolveConfig(undefined, { env: {}, cwd, shard: { current: 2, total: 3 } });
    expect(c.sessionId).toMatch(/^pw-s2of3-\d+-[0-9a-f]{8}$/u);
  });

  it('replaces malformed values by defaults and says so', () => {
    const c = resolveConfig(
      { maxAttachmentBytes: 1.5 },
      {
        env: {
          QE_REPORT_ENABLED: 'maybe',
          QE_REPORT_RUN_ID: 'has space',
          QE_REPORT_SESSION_ID: '',
        },
        cwd,
      },
    );
    expect(c.enabled).toBe(true);
    expect(c.runIdGenerated).toBe(true);
    expect(c.maxAttachmentBytes).toBeUndefined();
    expect(c.notes).toHaveLength(3);
    expect(c.notes.join('\n')).toContain('QE_REPORT_ENABLED');
    expect(c.notes.join('\n')).toContain("run id 'has space'");
    expect(c.notes.join('\n')).toContain('maxAttachmentBytes');
  });
});
