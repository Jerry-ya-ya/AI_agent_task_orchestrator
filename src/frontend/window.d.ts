export {};

declare global {
  interface Window {
    desktopWindow?: {
      minimize?(): Promise<boolean>;
      openPage?(page: 'features' | 'taskboard' | 'history' | 'settings', screenX: number, screenY: number): Promise<boolean>;
      setIcon?(icon: 'original' | 'violet' | 'ember' | 'frost'): Promise<boolean>;
      close(): Promise<boolean>;
    };
  }
}
