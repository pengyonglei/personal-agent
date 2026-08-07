import React, { useState, useCallback } from 'react';
import type { Theme } from './themes/theme';
import { darkTheme, lightTheme } from './themes/theme';
import type { UserAnswer } from '@personal-agent/shared';
import { AgentChatView } from './components/AgentChatView';
import { TuiContext } from './hooks/use-tui-context';
import { useAppState } from './hooks/use-app-state';
import { useInput } from 'ink';
import { VERSION_LABEL } from '@personal-agent/shared';
import type { DisplayQuestion } from './types';

export interface AppProps {
  model?: string;
  provider?: string;
  onUserInput: (text: string) => Promise<void>;
  themeName?: 'dark' | 'light';
  onDispatchReady?: (dispatch: (action: any) => void) => void;
  onSlashCommand?: (input: string) => Promise<string | void>;
  /** Bridge: called when the user answers a pending question in the QuestionCard. */
  onAskUser?: (question: DisplayQuestion, answer: UserAnswer) => void;
}

/**
 * Root Ink application component.
 * Manages theme, global keybindings, and coordinates child components.
 */
export function App({
  model = '',
  provider = '',
  onUserInput,
  themeName = 'dark',
  onDispatchReady,
  onSlashCommand,
  onAskUser,
}: AppProps) {
  const [theme, setTheme] = useState<Theme>(
    themeName === 'light' ? lightTheme : darkTheme,
  );
  const [state, dispatch] = useAppState();
  const [isProcessing, setIsProcessing] = useState(false);
  const [version] = useState(VERSION_LABEL);

  // Set model info on first render
  React.useEffect(() => {
    dispatch({ type: 'SET_MODEL_INFO', model, provider });
  }, [model, provider]);

  // Expose dispatch to the CLI layer so it can push agent events
  React.useEffect(() => {
    if (onDispatchReady) {
      onDispatchReady(dispatch);
    }
  }, [dispatch, onDispatchReady]);

  // Global keybindings
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      // Interrupt
      dispatch({
        type: 'ADD_SYSTEM_MESSAGE',
        text: '⏎ Interrupted',
      });
    }

    if (key.ctrl && input === 'l') {
      dispatch({ type: 'CLEAR_MESSAGES' });
    }

    if (key.ctrl && input === 't') {
      setTheme((prev) => (prev.name === 'dark' ? lightTheme : darkTheme));
    }

    // Ctrl+E: expand/collapse the last tool call result
    if (key.ctrl && input === 'e') {
      const toolMsgs = state.messages.filter((m) => m.role === 'tool' && m.toolCalls?.length);
      if (toolMsgs.length > 0) {
        const lastTool = toolMsgs[toolMsgs.length - 1];
        const lastTc = lastTool.toolCalls![0];
        dispatch({ type: 'TOGGLE_EXPAND', toolId: lastTc.id });
      }
    }
  });

  const handleQuestionAnswer = useCallback(
    (question: DisplayQuestion, answer: UserAnswer) => {
      dispatch({ type: 'CLEAR_QUESTION' });
      onAskUser?.(question, answer);
    },
    [onAskUser, dispatch],
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      if (isProcessing || !text.trim()) return;

      // Route slash commands: try local first, then delegate to CLI backend
      if (text.startsWith('/')) {
        const cmd = text.split(/\s+/)[0].slice(1);

        // Local-only commands
        if (cmd === 'theme') {
          setTheme(lightTheme);
          dispatch({ type: 'ADD_SYSTEM_MESSAGE', text: 'Theme toggled.' });
          return;
        }

        // Delegate to CLI backend (session, plan, model, etc.)
        if (onSlashCommand) {
          dispatch({ type: 'SET_STREAMING', value: true });
          dispatch({ type: 'SET_STATUS', text: 'Processing...' });
          setIsProcessing(true);
          try {
            const result = await onSlashCommand(text);
            if (result) {
              dispatch({ type: 'ADD_SYSTEM_MESSAGE', text: result });
            }
          } catch (err) {
            dispatch({
              type: 'ADD_SYSTEM_MESSAGE',
              text: `Error: ${(err as Error).message}`,
            });
          } finally {
            dispatch({ type: 'SET_STREAMING', value: false });
            dispatch({ type: 'SET_STATUS', text: '' });
            setIsProcessing(false);
          }
        }
        return;
      }

      dispatch({ type: 'ADD_USER_MESSAGE', text });
      dispatch({ type: 'SET_STREAMING', value: true });
      dispatch({ type: 'SET_STATUS', text: 'Thinking...' });
      setIsProcessing(true);

      try {
        await onUserInput(text);
      } catch (err) {
        dispatch({
          type: 'ADD_SYSTEM_MESSAGE',
          text: `Error: ${(err as Error).message}`,
        });
      } finally {
        dispatch({ type: 'SET_STREAMING', value: false });
        dispatch({ type: 'SET_STATUS', text: '' });
        setIsProcessing(false);
      }
    },
    [isProcessing, onUserInput, onSlashCommand, dispatch],
  );

  return (
    <TuiContext.Provider value={{ theme, setTheme }}>
      <AgentChatView
        state={state}
        dispatch={dispatch}
        onSubmit={handleSubmit}
        disabled={isProcessing}
        pendingQuestion={state.pendingQuestion}
        onQuestionAnswer={handleQuestionAnswer}
      />
    </TuiContext.Provider>
  );
}
