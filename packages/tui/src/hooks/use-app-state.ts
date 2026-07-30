import { useReducer, type Reducer } from 'react';
import type { AppState, AppAction, ChatMessage, DisplayToolCall } from '../types';

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

function createInitialState(): AppState {
  return {
    messages: [],
    isStreaming: false,
    tokenUsage: { input: 0, output: 0 },
    model: '',
    provider: '',
    turnCount: 0,
    statusText: '',
    plan: null,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const appReducer: Reducer<AppState, AppAction> = (state, action) => {
  switch (action.type) {
    case 'ADD_USER_MESSAGE': {
      const msg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: action.text,
        timestamp: new Date(),
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case 'APPEND_TEXT': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          content: last.content + action.text,
        };
      } else {
        msgs.push({
          id: `asst-${Date.now()}`,
          role: 'assistant',
          content: action.text,
          timestamp: new Date(),
        });
      }
      return { ...state, messages: msgs };
    }

    case 'TOOL_CALL_START': {
      // Insert a tool message into the messages array so it appears
      // between the preceding assistant text and the following content
      const tc: DisplayToolCall = {
        id: action.id,
        name: action.name,
        status: 'running',
        expanded: false,
      };
      const msg: ChatMessage = {
        id: `tool-${action.id}`,
        role: 'tool',
        content: '',
        timestamp: new Date(),
        toolCalls: [tc],
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case 'TOOL_CALL_END': {
      // Find the tool message by its id and update status + output
      const msgs = state.messages.map((m) => {
        if (m.id !== `tool-${action.id}`) return m;
        const existing = m.toolCalls?.[0];
        if (!existing) return m;
        const updatedTc: DisplayToolCall = {
          ...existing,
          status: action.result.success ? 'done' : 'error',
          result: action.result,
          outputPreview: (action.result.content ?? action.result.error ?? '').slice(0, 200),
        };
        return { ...m, toolCalls: [updatedTc] };
      });
      return { ...state, messages: msgs };
    }

    case 'SET_STREAMING':
      return { ...state, isStreaming: action.value };

    case 'SET_STATUS':
      return { ...state, statusText: action.text };

    case 'CLEAR_MESSAGES':
      return {
        ...state,
        messages: [],
        tokenUsage: { input: 0, output: 0 },
      };

    case 'UPDATE_USAGE':
      return {
        ...state,
        tokenUsage: {
          input: state.tokenUsage.input + action.input,
          output: state.tokenUsage.output + action.output,
        },
      };

    case 'SET_MODEL_INFO':
      return {
        ...state,
        model: action.model,
        provider: action.provider,
      };

    case 'ADD_SYSTEM_MESSAGE': {
      const msg: ChatMessage = {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: action.text,
        timestamp: new Date(),
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case 'SET_PLAN':
      return { ...state, plan: action.plan };

    case 'TOGGLE_EXPAND': {
      const msgs = state.messages.map((m) => {
        if (m.id !== `tool-${action.toolId}`) return m;
        const existing = m.toolCalls?.[0];
        if (!existing) return m;
        return { ...m, toolCalls: [{ ...existing, expanded: !existing.expanded }] };
      });
      return { ...state, messages: msgs };
    }

    default:
      return state;
  }
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAppState() {
  return useReducer(appReducer, null as unknown as AppState, createInitialState);
}
