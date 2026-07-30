import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export interface Theme {
  name: 'dark' | 'light';
  colors: {
    background: string;
    text: string;
    textDim: string;
    border: string;
    accent: string;
    success: string;
    error: string;
    warning: string;
    userMessage: string;
    assistantMessage: string;
    toolCall: string;
    statusBar: string;
    inputPrompt: string;
  };
}

export const darkTheme: Theme = {
  name: 'dark',
  colors: {
    background: '#000000',
    text: '#e0e0e0',
    textDim: '#666666',
    border: '#333333',
    accent: '#00bcd4',
    success: '#4caf50',
    error: '#f44336',
    warning: '#ff9800',
    userMessage: '#81d4fa',
    assistantMessage: '#e0e0e0',
    toolCall: '#ffcc80',
    statusBar: '#1a1a2e',
    inputPrompt: '#00bcd4',
  },
};

export const lightTheme: Theme = {
  name: 'light',
  colors: {
    background: '#ffffff',
    text: '#333333',
    textDim: '#999999',
    border: '#dddddd',
    accent: '#0288d1',
    success: '#388e3c',
    error: '#d32f2f',
    warning: '#f57c00',
    userMessage: '#1565c0',
    assistantMessage: '#333333',
    toolCall: '#e65100',
    statusBar: '#f5f5f5',
    inputPrompt: '#0288d1',
  },
};
