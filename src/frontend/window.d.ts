export {};

declare global {
  interface Window {
    desktopWindow?: {
      apiBaseUrl?: string;
      chooseRepository?(suggestedPath: string): Promise<string | null>;
      startDragging?(toggleMaximize: boolean): Promise<boolean>;
      minimize?(): Promise<boolean>;
      openPage?(request: {
        page: 'features' | 'taskboard' | 'history' | 'worklog' | 'settings' | 'frontend';
        connectionId?: string;
        screenX: number;
        screenY: number;
      }): Promise<boolean>;
      setIcon?(icon: 'original' | 'violet' | 'ember' | 'frost'): Promise<boolean>;
      close(): Promise<boolean>;
    };
  }
}
