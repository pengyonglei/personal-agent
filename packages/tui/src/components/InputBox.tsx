import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { default as TextInput } from 'ink-text-input';
import { useTuiContext } from '../hooks/use-tui-context';

export interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  history?: string[];
}

export function InputBox({ onSubmit, disabled = false, history = [] }: InputBoxProps) {
  const { theme } = useTuiContext();
  const { colors } = theme;
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        onSubmit(trimmed);
      }
      setValue('');
      setHistoryIndex(-1);
    },
    [onSubmit],
  );

  return (
    <Box
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={colors.border}
    >
      <Text color={colors.inputPrompt}>▸ </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="Type a message... (/help for commands)"
        showCursor
      />
    </Box>
  );
}
