export type ValidationProfileName = 'quick' | 'full';
export type ValidationStatus = 'passed' | 'failed' | 'infrastructure_error';
export type ValidationArtifactKind = 'screenshot' | 'trace' | 'log' | 'report' | 'dom';

export interface ValidationArtifact {
  id: string;
  kind: ValidationArtifactKind;
  name: string;
  mimeType: string;
  size: number;
}

export interface ValidationViewport {
  width: number;
  height: number;
}

export interface ValidationAction {
  action: 'click' | 'fill' | 'press' | 'check' | 'uncheck' | 'select' | 'wait';
  role?: string;
  name?: string;
  testId?: string;
  text?: string;
  selector?: string;
  value?: string;
  key?: string;
  timeoutMs?: number;
}

export interface ValidationAssertion {
  assert: 'visible' | 'hidden' | 'text' | 'url' | 'count';
  role?: string;
  name?: string;
  testId?: string;
  text?: string;
  selector?: string;
  value?: string;
  count?: number;
}

export interface ValidationScenario {
  name: string;
  path?: string;
  profiles?: ValidationProfileName[];
  actions?: ValidationAction[];
  assertions?: ValidationAssertion[];
  screenshot?: boolean | string;
}

export interface ValidationCommand {
  command: string;
  timeoutMs?: number;
}

export interface ValidationConfig {
  version: 1;
  server: {
    command?: string;
    url: string;
    healthUrl?: string;
    timeoutMs: number;
    reuseExisting: boolean;
    env: Record<string, string>;
  };
  browser: {
    viewport: ValidationViewport;
    colorScheme: 'light' | 'dark' | 'no-preference';
    locale?: string;
    executablePath?: string;
  };
  checks: {
    quick: ValidationCommand[];
    full: ValidationCommand[];
  };
  scenarios: ValidationScenario[];
  network: {
    failOnRequestError: boolean;
    failOnHttpStatus: number;
    ignore: string[];
  };
  console: {
    failOn: Array<'error' | 'warning'>;
    ignore: string[];
  };
  artifacts: {
    root?: string;
    keepRuns: number;
    trace: 'off' | 'retain-on-failure' | 'on';
  };
  vision?: {
    enabled: boolean;
    provider?: string;
    model?: string;
    prompt?: string;
  };
}

export interface ValidationStepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

export interface ValidationIssue {
  source: 'check' | 'console' | 'network' | 'page' | 'assertion' | 'vision' | 'infrastructure';
  message: string;
  scenario?: string;
}

export interface ValidationRunResult {
  runId: string;
  projectHash: string;
  profile: ValidationProfileName;
  status: ValidationStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  steps: ValidationStepResult[];
  issues: ValidationIssue[];
  artifacts: ValidationArtifact[];
  artifactDirectory: string;
  vision: {
    status: 'passed' | 'failed' | 'skipped';
    reason?: string;
  };
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: Array<{
    role: string;
    name: string;
    testId?: string;
    disabled?: boolean;
  }>;
}

export interface VisualReviewInput {
  screenshotPath: string;
  scenario: string;
  prompt: string;
}

export interface VisualReviewResult {
  passed: boolean;
  summary: string;
}

export type VisualReviewer = (input: VisualReviewInput) => Promise<VisualReviewResult>;
