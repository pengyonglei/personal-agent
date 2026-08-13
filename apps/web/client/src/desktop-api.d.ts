interface PersonalAgentDesktopApi {
  selectDirectory(suggestedPath?: string): Promise<string | null>;
  toggleDevTools(): Promise<void>;
  /** 在系统文件管理器中打开指定目录；成功返回 null，失败返回错误信息。 */
  openPath(targetPath: string): Promise<string | null>;
  /** 显示任务完成的系统通知；仅桌面版提供。 */
  showTaskCompletionNotification(payload: { taskId: string; title: string }): Promise<boolean>;
  /** 显示等待权限审批的系统通知；点击后定位到对应任务。 */
  showPermissionRequestNotification(payload: {
    taskId: string;
    title: string;
    toolName: string;
  }): Promise<boolean>;
  /** 显示等待用户回答计划问询的系统通知；点击后定位到对应任务。 */
  showQuestionRequestNotification(payload: { taskId: string; title: string }): Promise<boolean>;
  /** 用户点击系统通知后，请求前端定位到对应任务。 */
  onOpenTaskRequested(listener: (taskId: string) => void): () => void;
  setBrowserViewLayout(payload: {
    sessionId: string;
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
  }): Promise<boolean>;
  getBrowserViewState(sessionId: string): Promise<DesktopBrowserViewState | null>;
  navigateBrowserView(
    sessionId: string,
    action: 'back' | 'forward' | 'reload',
  ): Promise<boolean>;
  onBrowserViewState(listener: (state: DesktopBrowserViewState) => void): () => void;
}

interface DesktopBrowserViewState {
  sessionId: string;
  status: 'creating' | 'loading' | 'ready' | 'crashed' | 'closed' | 'error';
  url: string;
  title: string;
  locked: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

interface Window {
  personalAgentDesktop?: PersonalAgentDesktopApi;
}
