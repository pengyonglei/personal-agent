import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { default as TextInput } from 'ink-text-input';
import type { UserAnswer } from '@personal-agent/shared';
import { useTuiContext } from '../hooks/use-tui-context';
import type { DisplayQuestion } from '../types';

export interface QuestionCardProps {
  question: DisplayQuestion;
  onAnswer: (answer: UserAnswer) => void;
}

/**
 * Interactive question card: renders the question with a selectable option
 * list (radio for single select, checkbox for multi select) plus a fixed
 * "custom answer" option that opens a text input.
 */
export function QuestionCard({ question, onAnswer }: QuestionCardProps) {
  const { theme } = useTuiContext();
  const { colors } = theme;
  const customIndex = question.options.length;
  const total = question.options.length + (question.allowCustom ? 1 : 0);

  const [cursor, setCursor] = useState(0);
  const [selections, setSelections] = useState<Set<string>>(new Set());
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');

  const submitCustom = useCallback(() => {
    onAnswer({ selections: [], custom: customText.trim() || undefined });
  }, [customText, onAnswer]);

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setCursor((c) => (c - 1 + total) % total);
      } else if (key.downArrow) {
        setCursor((c) => (c + 1) % total);
      } else if (input === ' ') {
        if (cursor === customIndex && question.allowCustom) {
          setSelections(new Set());
          setCustomMode(true);
          return;
        }
        if (question.multiSelect) {
          const option = question.options[cursor];
          setSelections((prev) => {
            const next = new Set(prev);
            if (next.has(option)) next.delete(option);
            else next.add(option);
            return next;
          });
        }
      } else if (key.return) {
        if (cursor === customIndex && question.allowCustom) {
          setSelections(new Set());
          setCustomMode(true);
          return;
        }
        if (question.multiSelect) {
          onAnswer({ selections: [...selections] });
        } else {
          onAnswer({ selections: [question.options[cursor]] });
        }
      }
    },
    { isActive: !customMode },
  );

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={colors.accent}
    >
      <Box>
        <Text color={colors.warning}>❓ </Text>
        <Text bold color={colors.text}>
          {question.question}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {question.options.map((option, i) => {
          const selected = selections.has(option);
          const focused = cursor === i;
          const marker = question.multiSelect
            ? selected
              ? '[✓]'
              : '[ ]'
            : focused
              ? '(•)'
              : '( )';
          return (
            <Text key={option} color={focused ? colors.accent : colors.text} bold={focused}>
              {marker} {option}
            </Text>
          );
        })}
        {question.allowCustom && (
          <Box flexDirection="column">
            {customMode ? (
              <Box>
                <Text color={colors.accent}>✎ </Text>
                <TextInput
                  value={customText}
                  onChange={setCustomText}
                  onSubmit={submitCustom}
                  placeholder="输入自定义答案…"
                  showCursor
                />
              </Box>
            ) : (
              <Text
                color={cursor === customIndex ? colors.accent : colors.text}
                bold={cursor === customIndex}
              >
                {question.multiSelect ? '[ ]' : '( )'} ✎ 自定义答案
              </Text>
            )}
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {customMode
            ? 'Enter 提交自定义答案'
            : question.multiSelect
              ? '↑/↓ 移动 · 空格 多选 · Enter 提交'
              : '↑/↓ 选择 · Enter 确认'}
        </Text>
      </Box>
    </Box>
  );
}
