import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWebServer } from '../src/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'personal-agent-validation-'));
const configPath = join(directory, 'config.yaml');
await writeFile(
  configPath,
  [
    'memory:',
    '  enabled: false',
    'plugins:',
    '  enabled: false',
    'skills:',
    '  enabled: false',
    'mcp:',
    '  servers: []',
  ].join('\n'),
  'utf8',
);
process.env.PERSONAL_AGENT_FAKE_PROVIDER = '1';

const instance = await createWebServer({
  host: '127.0.0.1',
  port: Number(process.env.PORT ?? 5681),
  workingDirectory: resolve(import.meta.dirname, '../../..'),
  configPath,
  projectStoragePath: join(directory, 'projects.json'),
  sessionsDirectory: join(directory, 'sessions'),
  plansDirectory: join(directory, 'plans'),
  fileChangesDirectory: join(directory, 'file-changes'),
  skillsDirectory: join(directory, 'skills'),
  statsDbPath: join(directory, 'stats.db'),
  viteDev: true,
});

console.log(`validation server ready: http://${instance.host}:${instance.port}`);
const shutdown = () => void instance.close().finally(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
