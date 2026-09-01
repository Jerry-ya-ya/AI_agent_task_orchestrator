export {};

declare global {
  interface Window {
    desktopWindow?: {
      close(): void;
    };
  }
}
