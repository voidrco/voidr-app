import type { VoidrCaptureBridge } from '../../preload/control';
export function mountJourney(root: ShadowRoot, api: VoidrCaptureBridge['journeys'], onRunning: (running: boolean) => void, onBack: () => void): () => void;
