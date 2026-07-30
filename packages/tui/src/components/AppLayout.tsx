import React from 'react';
import { Box } from 'ink';
import { StatusBar, type StatusBarProps } from './StatusBar';
import { MessageList, type MessageListProps } from './MessageList';
import { InputBox, type InputBoxProps } from './InputBox';

export interface AppLayoutProps {
  statusBar: StatusBarProps;
  messages: MessageListProps;
  input: InputBoxProps;
}

/**
 * Overall app layout:
 * ┌─ StatusBar ────────────────────┐
 * │  model · tokens · turns        │
 * ├─ Messages ─────────────────────┤
 * │                                │
 * │  chat messages + tool calls    │
 * │                                │
 * ├─ InputBox ─────────────────────┤
 * │  ▸ type here...                │
 * └────────────────────────────────┘
 */
export function AppLayout({ statusBar, messages, input }: AppLayoutProps) {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar {...statusBar} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <MessageList
          messages={messages.messages}
          isStreaming={messages.isStreaming}
        />
      </Box>
      <InputBox {...input} />
    </Box>
  );
}
