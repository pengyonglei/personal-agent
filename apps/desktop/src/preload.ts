import { contextBridge, ipcRenderer } from 'electron';

const SELECT_DIRECTORY_CHANNEL = 'desktop:select-directory';
const TOGGLE_DEVTOOLS_CHANNEL = 'desktop:toggle-devtools';
const OPEN_PATH_CHANNEL = 'desktop:open-path';
const TASK_COMPLETION_NOTIFICATION_CHANNEL = 'desktop:task-completion-notification';
const PERMISSION_REQUEST_NOTIFICATION_CHANNEL = 'desktop:permission-request-notification';
const QUESTION_REQUEST_NOTIFICATION_CHANNEL = 'desktop:question-request-notification';
const OPEN_TASK_REQUESTED_CHANNEL = 'desktop:open-task-requested';

contextBridge.exposeInMainWorld(
  'personalAgentDesktop',
  Object.freeze({
    selectDirectory: (suggestedPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(SELECT_DIRECTORY_CHANNEL, suggestedPath) as Promise<string | null>,
    toggleDevTools: (): Promise<void> =>
      ipcRenderer.invoke(TOGGLE_DEVTOOLS_CHANNEL) as Promise<void>,
    openPath: (targetPath: string): Promise<string | null> =>
      ipcRenderer.invoke(OPEN_PATH_CHANNEL, targetPath) as Promise<string | null>,
    showTaskCompletionNotification: (payload: {
      taskId: string;
      title: string;
    }): Promise<boolean> =>
      ipcRenderer.invoke(TASK_COMPLETION_NOTIFICATION_CHANNEL, payload) as Promise<boolean>,
    showPermissionRequestNotification: (payload: {
      taskId: string;
      title: string;
      toolName: string;
    }): Promise<boolean> =>
      ipcRenderer.invoke(PERMISSION_REQUEST_NOTIFICATION_CHANNEL, payload) as Promise<boolean>,
    showQuestionRequestNotification: (payload: {
      taskId: string;
      title: string;
    }): Promise<boolean> =>
      ipcRenderer.invoke(QUESTION_REQUEST_NOTIFICATION_CHANNEL, payload) as Promise<boolean>,
    onOpenTaskRequested: (listener: (taskId: string) => void): (() => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, taskId: unknown) => {
        if (typeof taskId === 'string' && taskId) listener(taskId);
      };
      ipcRenderer.on(OPEN_TASK_REQUESTED_CHANNEL, subscription);
      return () => ipcRenderer.removeListener(OPEN_TASK_REQUESTED_CHANNEL, subscription);
    },
  }),
);
