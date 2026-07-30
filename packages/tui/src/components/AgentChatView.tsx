import React, { useState, useCallback, type Dispatch } from 'react';
import { Box } from 'ink';
import { default as InkTextInput } from 'ink-text-input';
import type { AppAction, AppState } from '../types';
import { useTuiContext } from '../hooks/use-tui-context';
import { StatusBar } from './StatusBar';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import { PlanSidebar } from './PlanSidebar';

export interface AgentChatViewProps {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

/**
 * The main chat view that composes StatusBar + MessageList + InputBox.
 * This is the primary component rendered in the Ink app.
 */
export function AgentChatView({ state, dispatch, onSubmit, disabled = false }: AgentChatViewProps) {
  const { theme } = useTuiContext();

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar
        model={state.model}
        provider={state.provider}
        inputTokens={state.tokenUsage.input}
        outputTokens={state.tokenUsage.output}
        turnCount={state.turnCount}
        statusText={state.statusText}
      />

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          <MessageList messages={state.messages} isStreaming={state.isStreaming} />
        </Box>
        {state.plan ? <PlanSidebar plan={state.plan} /> : null}
      </Box>

      <InputBox onSubmit={onSubmit} disabled={disabled} />
    </Box>
  );
}
