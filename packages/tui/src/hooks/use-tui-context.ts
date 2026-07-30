import React, { createContext, useContext } from 'react';
import type { Theme } from '../themes/theme';
import { darkTheme } from '../themes/theme';

export interface TuiContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export const TuiContext = createContext<TuiContextValue>({
  theme: darkTheme,
  setTheme: () => {},
});

export function useTuiContext(): TuiContextValue {
  return useContext(TuiContext);
}
