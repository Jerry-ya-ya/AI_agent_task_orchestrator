export {};

declare global {
  interface Window {
    desktopWindow?: {
      chooseRepository?(suggestedPath: string): Promise<string | null>;
      minimize?(): Promise<boolean>;
      openPage?(request: {
        page: 'features' | 'taskboard' | 'history' | 'settings' | 'frontend';
        connectionId?: string;
        screenX: number;
        screenY: number;
      }): Promise<boolean>;
      setIcon?(icon: 'original' | 'violet' | 'ember' | 'frost'): Promise<boolean>;
      close(): Promise<boolean>;
    };
  }
}
