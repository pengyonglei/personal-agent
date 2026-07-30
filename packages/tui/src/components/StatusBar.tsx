import React from 'react';
import { Box, Text } from 'ink';
import { useTuiContext } from '../hooks/use-tui-context';

export interface StatusBarProps {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  statusText: string;
}

export function StatusBar(props: StatusBarProps) {
  const { theme } = useTuiContext();
  const { colors } = theme;

  return (
    <Box
      width="100%"
      paddingX={1}
      borderStyle="single"
      borderColor={colors.border}
      
      justifyContent="space-between"
    >
      <Box gap={2}>
        <Text color={colors.accent}>
          {props.provider ? `${props.provider} / ${props.model}` : 'no model'}
        </Text>
        <Text dimColor>
          ↓{formatTokens(props.inputTokens)} ↑{formatTokens(props.outputTokens)}
        </Text>
        <Text dimColor>
          T: {props.turnCount}
        </Text>
      </Box>
      <Box>
        {props.statusText ? (
          <Text color={colors.warning}>{props.statusText}</Text>
        ) : (
          <Text dimColor>Ready</Text>
        )}
      </Box>
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
