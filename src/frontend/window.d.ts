export {};

declare global {
  interface Window {
    desktopWindow?: {
      minimize?(): Promise<boolean>;
      close(): Promise<boolean>;
    };
  }
}
