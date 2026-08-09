import type { VoidrCaptureBridge } from '../preload/control';

declare global {
  interface Window {
    voidrCapture: VoidrCaptureBridge;
  }
}

export {};
