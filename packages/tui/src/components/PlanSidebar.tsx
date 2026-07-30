import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayPlan } from '../types';
import { useTuiContext } from '../hooks/use-tui-context';

export interface PlanSidebarProps {
  plan: DisplayPlan;
}

export function PlanSidebar({ plan }: PlanSidebarProps) {
  const { theme } = useTuiContext();
  const { colors } = theme;

  return (
    <Box
      width={34}
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.border}
      paddingX={1}
    >
      <Text bold color={colors.accent}>
        Plan
      </Text>
      <Text wrap="truncate-end">{plan.title}</Text>
      <Text dimColor>
        {plan.status} · {plan.percentage}%
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {plan.steps.map((step) => (
          <Text
            key={step.id}
            color={
              step.status === 'failed'
                ? colors.error
                : step.status === 'in_progress'
                  ? colors.warning
                  : step.status === 'completed'
                    ? colors.success
                    : undefined
            }
            dimColor={step.status === 'pending' || step.status === 'skipped'}
            wrap="truncate-end"
          >
            {stepMarker(step.status)} {step.title}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function stepMarker(status: DisplayPlan['steps'][number]['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '›';
    case 'failed':
      return '✗';
    case 'skipped':
      return '–';
    default:
      return '○';
  }
}
