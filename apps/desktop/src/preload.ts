import { contextBridge, ipcRenderer } from 'electron';

const SELECT_DIRECTORY_CHANNEL = 'desktop:select-directory';

contextBridge.exposeInMainWorld(
  'personalAgentDesktop',
  Object.freeze({
    selectDirectory: (suggestedPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(SELECT_DIRECTORY_CHANNEL, suggestedPath) as Promise<string | null>,
  }),
);
