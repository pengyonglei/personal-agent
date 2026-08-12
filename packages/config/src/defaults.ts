import type { AppConfig } from './schema';
import { DEFAULT_VISION_PROMPT } from './schema';

/**
 * Default configuration values loaded before any user config.
 * These can be overridden by file config, env vars, and CLI flags.
 */
export const DEFAULT_CONFIG: AppConfig = {
  providers: {},
  agent: {
    maxTurns: 100,
    temperature: 0,
    planMode: {
      enabled: true,
      autoApprove: false,
    },
  },
  tools: {
    sandbox: {
      restrictPaths: true,
      allowedPaths: [],
      deniedCommands: [],
    },
    permissions: [],
    shellTimeout: 120000,
    webFetchTimeout: 30000,
    shell: 'auto',
  },
  mcp: {
    servers: [],
  },
  tui: {
    theme: 'dark',
    showTokenCounter: true,
    showCostEstimates: true,
    enableMouse: false,
  },
  web: {
    theme: 'light',
    accentLight: '#1677ff',
    accentDark: '#91caff',
  },
  stats: {
    enabled: true,
    recordPayloads: false,
    retentionDays: 90,
  },
  vision: {
    enabled: false,
    prompt: DEFAULT_VISION_PROMPT,
  },
  memory: {
    enabled: true,
    store: 'filesystem',
    maxEntries: 1000,
  },
  plugins: {
    enabled: true,
    paths: [],
    disabled: [],
  },
  skills: {
    enabled: true,
    paths: [],
  },
};
