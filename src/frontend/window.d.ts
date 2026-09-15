export {};

declare global {
  interface Window {
    desktopWindow?: {
      minimize?(): Promise<boolean>;
      openPage?(page: 'features' | 'taskboard' | 'history', screenX: number, screenY: number): Promise<boolean>;
      close(): Promise<boolean>;
    };
  }
}
