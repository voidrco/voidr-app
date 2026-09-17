import './fonts.css';
import { useEffect, useRef } from 'react';
import { mountJourney } from './renderer.js';
import markup from './original.html?raw';
import stylesheet from './original.css?url';
import logo from './assets/voidr.svg';

export function LoopsWorkspace({ onRunning, onBack }: {
  onRunning: (running: boolean) => void; onBack: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRunning, onBack });
  callbacks.current = { onRunning, onBack };
  useEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = stylesheet;
    root.innerHTML = markup.replace('__VOIDR_LOGO__', logo);
    root.prepend(link);
    const dispose = mountJourney(root, window.voidrCapture.journeys,
      running => callbacks.current.onRunning(running), () => callbacks.current.onBack());
    return () => { dispose(); root.replaceChildren(); };
  }, []);
  return <div ref={host} aria-label="Voidr Loops" />;
}
