import type { Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

/** Minimal Playwright objects for mapping tests; only the members the reporter reads exist. */
export const ROOT = '/work/project';

export function suite(
  type: Suite['type'],
  title: string,
  parent?: Suite,
  projectName?: string,
): Suite {
  return {
    type,
    title,
    parent,
    suites: [],
    tests: [],
    project: () => (projectName === undefined ? undefined : { name: projectName }),
    titlePath: () => [],
    allTests: () => [],
    entries: () => [],
  } as unknown as Suite;
}

export interface FakeTestOptions {
  readonly id?: string;
  readonly title?: string;
  readonly file?: string;
  readonly line?: number;
  readonly project?: string;
  readonly groups?: readonly string[];
  readonly repeatEachIndex?: number;
  readonly tags?: readonly string[];
  readonly annotations?: readonly { type: string; description?: string }[];
  readonly expectedStatus?: TestCase['expectedStatus'];
}

export function testCase(o: FakeTestOptions = {}): TestCase {
  const project = o.project ?? 'desktop';
  const root = suite('root', '');
  const projectSuite = suite('project', project, root, project);
  const fileSuite = suite('file', 'a.spec.ts', projectSuite, project);
  let parent = fileSuite;
  for (const g of o.groups ?? []) parent = suite('describe', g, parent, project);
  return {
    id: o.id ?? 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb',
    title: o.title ?? 'does a thing',
    parent,
    location: { file: o.file ?? `${ROOT}/tests/a.spec.ts`, line: o.line ?? 3, column: 1 },
    repeatEachIndex: o.repeatEachIndex ?? 0,
    retries: 0,
    tags: [...(o.tags ?? [])],
    annotations: [...(o.annotations ?? [])],
    expectedStatus: o.expectedStatus ?? 'passed',
    timeout: 1000,
    type: 'test',
    results: [],
    ok: () => true,
    outcome: () => 'expected',
    titlePath: () => [],
  } as unknown as TestCase;
}

export function testResult(o: Partial<TestResult> = {}): TestResult {
  return {
    retry: 0,
    workerIndex: 0,
    parallelIndex: 0,
    duration: 5,
    status: 'passed',
    startTime: new Date(0),
    attachments: [],
    errors: [],
    stdout: [],
    stderr: [],
    steps: [],
    annotations: [],
    ...o,
  } as TestResult;
}

export function testStep(o: Partial<TestStep> & { title: string; category: string }): TestStep {
  return {
    duration: 1,
    startTime: new Date(0),
    steps: [],
    attachments: [],
    annotations: [],
    titlePath: () => [],
    ...o,
  } as unknown as TestStep;
}
