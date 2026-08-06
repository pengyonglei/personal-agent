interface PersonalAgentDesktopApi {
  selectDirectory(suggestedPath?: string): Promise<string | null>;
  toggleDevTools(): Promise<void>;
}

interface Window {
  personalAgentDesktop?: PersonalAgentDesktopApi;
}
