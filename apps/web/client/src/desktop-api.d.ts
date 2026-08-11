interface PersonalAgentDesktopApi {
  selectDirectory(suggestedPath?: string): Promise<string | null>;
  toggleDevTools(): Promise<void>;
  /** 在系统文件管理器中打开指定目录；成功返回 null，失败返回错误信息。 */
  openPath(targetPath: string): Promise<string | null>;
}

interface Window {
  personalAgentDesktop?: PersonalAgentDesktopApi;
}
