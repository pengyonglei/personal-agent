import { contextBridge, ipcRenderer } from 'electron';

const SELECT_DIRECTORY_CHANNEL = 'desktop:select-directory';
const TOGGLE_DEVTOOLS_CHANNEL = 'desktop:toggle-devtools';

contextBridge.exposeInMainWorld(
  'personalAgentDesktop',
  Object.freeze({
    selectDirectory: (suggestedPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(SELECT_DIRECTORY_CHANNEL, suggestedPath) as Promise<string | null>,
    toggleDevTools: (): Promise<void> =>
      ipcRenderer.invoke(TOGGLE_DEVTOOLS_CHANNEL) as Promise<void>,
  }),
);
