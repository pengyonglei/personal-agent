interface PersonalAgentDesktopApi {
  selectDirectory(suggestedPath?: string): Promise<string | null>;
}

interface Window {
  personalAgentDesktop?: PersonalAgentDesktopApi;
}
