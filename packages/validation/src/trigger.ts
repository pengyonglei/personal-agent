import { extname, normalize } from 'node:path';

const FRONTEND_EXTENSIONS = new Set([
  '.css',
  '.less',
  '.scss',
  '.sass',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.jsx',
  '.tsx',
]);
const FRONTEND_DIRECTORIES = [
  'client/',
  'frontend/',
  'src/components/',
  'src/pages/',
  'src/views/',
  'src/routes/',
  'public/',
];

export function isFrontendFile(path: string): boolean {
  const normalized = normalize(path).replaceAll('\\', '/').toLowerCase();
  const extension = extname(normalized);
  if (FRONTEND_EXTENSIONS.has(extension)) return true;
  if (!['.js', '.ts'].includes(extension)) return false;
  return FRONTEND_DIRECTORIES.some(
    (directory) => normalized.includes(`/${directory}`) || normalized.startsWith(directory),
  );
}

export class FrontendValidationGate {
  private changed = new Set<string>();
  private revision = 0;
  private failedAttempts = 0;
  private validatedFingerprint = '';

  recordFile(path: string): void {
    if (isFrontendFile(path)) {
      this.changed.add(normalize(path));
      this.revision += 1;
    }
  }

  recordValidation(success: boolean): void {
    if (success) {
      this.validatedFingerprint = this.fingerprint();
      this.failedAttempts = 0;
    } else {
      this.failedAttempts += 1;
    }
  }

  needsValidation(): boolean {
    return this.changed.size > 0 && this.fingerprint() !== this.validatedFingerprint;
  }

  requiredFollowup(): string | undefined {
    if (!this.needsValidation()) return undefined;
    if (this.failedAttempts >= 3) return undefined;
    if (this.failedAttempts === 0) {
      return `You modified frontend files (${[...this.changed].join(', ')}). Before finishing, call frontend_validate with profile=quick and inspect its evidence.`;
    }
    return `Frontend validation is still failing. Fix the evidence-backed problem and run frontend_validate again. You may perform at most ${3 - this.failedAttempts} more validation attempt(s).`;
  }

  /** Clear pending validation work when browser validation is turned off. */
  reset(): void {
    this.changed.clear();
    this.revision = 0;
    this.failedAttempts = 0;
    this.validatedFingerprint = '';
  }

  private fingerprint(): string {
    return `${this.revision}\n${[...this.changed].sort().join('\n')}`;
  }
}
