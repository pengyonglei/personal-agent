// ---------------------------------------------------------------------------
// Shared types for the TUI layer
// ---------------------------------------------------------------------------

import type { ToolResult } from '@personal-agent/shared';

/** A single chat message in the TUI */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  /** Tool calls if this is an assistant message */
  toolCalls?: DisplayToolCall[];
}

/** Display state for a tool call */
export interface DisplayToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: ToolResult;
  outputPreview?: string;
  expanded: boolean;
}

export interface DisplayPlan {
  title: string;
  status: 'draft' | 'approved' | 'in_progress' | 'completed';
  percentage: number;
  steps: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  }>;
}

/** Complete app state */
export interface AppState {
  messages: ChatMessage[];
  isStreaming: boolean;
  tokenUsage: {
    input: number;
    output: number;
  };
  model: string;
  provider: string;
  turnCount: number;
  statusText: string;
  plan: DisplayPlan | null;
}

/** Actions that can be dispatched */
export type AppAction =
  | { type: 'ADD_USER_MESSAGE'; text: string }
  | { type: 'APPEND_TEXT'; text: string }
  | { type: 'TOOL_CALL_START'; id: string; name: string }
  | { type: 'TOOL_CALL_END'; id: string; result: ToolResult }
  | { type: 'SET_STREAMING'; value: boolean }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'UPDATE_USAGE'; input: number; output: number }
  | { type: 'SET_MODEL_INFO'; model: string; provider: string }
  | { type: 'ADD_SYSTEM_MESSAGE'; text: string }
  | { type: 'SET_PLAN'; plan: DisplayPlan | null }
  | { type: 'TOGGLE_EXPAND'; toolId: string };
