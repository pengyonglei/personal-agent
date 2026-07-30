import React from 'react';
import { Box, Text, Newline } from 'ink';
import { useTuiContext } from '../hooks/use-tui-context';
import type { ChatMessage, DisplayToolCall } from '../types';

export interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
}

export function MessageList({ messages, isStreaming }: MessageListProps) {
  const { theme } = useTuiContext();
  const { colors } = theme;

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg) => (
        <MessageRow key={msg.id} msg={msg} colors={colors} />
      ))}

      {/* Streaming indicator */}
      {isStreaming && (
        <Box>
          <Text color={colors.accent} dimColor>
            ● Thinking...
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Single message row
// ---------------------------------------------------------------------------

function MessageRow({
  msg,
  colors,
}: {
  msg: ChatMessage;
  colors: Record<string, string>;
}) {
  // Tool messages render as a tool call card, not as text
  if (msg.role === 'tool' && msg.toolCalls?.length) {
    return (
      <Box flexDirection="column" marginY={1}>
        {msg.toolCalls.map((tc) => (
          <ToolCallCard key={tc.id} tc={tc} colors={colors} />
        ))}
      </Box>
    );
  }

  const color =
    msg.role === 'user'
      ? colors.userMessage
      : msg.role === 'system'
        ? colors.warning
        : colors.assistantMessage;

  const prefix =
    msg.role === 'user' ? '▸ ' : msg.role === 'system' ? '⚡ ' : '';

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={color}>
        {prefix}<Text>{msg.content}</Text>
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tool call card
// ---------------------------------------------------------------------------

function ToolCallCard({
  tc,
  colors,
}: {
  tc: DisplayToolCall;
  colors: Record<string, string>;
}) {
  const statusColor =
    tc.status === 'running'
      ? colors.warning
      : tc.status === 'done'
        ? colors.success
        : tc.status === 'error'
          ? colors.error
          : colors.textDim;

  const icon =
    tc.status === 'running'
      ? '◷'
      : tc.status === 'done'
        ? '✓'
        : tc.status === 'error'
          ? '✗'
          : '○';

  return (
    <Box flexDirection="column" marginLeft={2} marginY={1}>
      <Box>
        <Text color={statusColor}>
          {icon} {tc.name}
        </Text>
        {tc.status === 'running' && (
          <Text color={colors.warning}> ...</Text>
        )}
        {tc.status !== 'running' && tc.outputPreview && (
          <Text dimColor> ({tc.expanded ? '− fold' : '+ expand'})</Text>
        )}
      </Box>
      {tc.outputPreview && tc.status !== 'running' && tc.expanded && (
        <Box marginLeft={2} borderStyle="round" borderColor={colors.border} paddingX={1} marginTop={1}>
          <Text dimColor>
            {tc.outputPreview.split('\n').slice(0, 3).join('\n')}
            {(tc.outputPreview.length > 200 || tc.outputPreview.includes('\n')) ? '...' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
