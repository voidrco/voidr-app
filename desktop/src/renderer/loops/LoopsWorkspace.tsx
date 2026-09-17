import { useLayoutEffect, useRef } from 'react';
import { mountJourney } from './renderer.js';
import markup from './original.html?raw';
import stylesheet from './original.css?inline';
import logo from './assets/voidr.svg';

const journeyStyles = new CSSStyleSheet();
journeyStyles.replaceSync(stylesheet);

export function LoopsWorkspace({ onRunning, onBack }: {
  onRunning: (running: boolean) => void; onBack: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRunning, onBack });
  callbacks.current = { onRunning, onBack };
  useLayoutEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [journeyStyles];
    root.innerHTML = markup.replace('__VOIDR_LOGO__', logo);
    const dispose = mountJourney(root, window.voidrCapture.journeys,
      running => callbacks.current.onRunning(running), () => callbacks.current.onBack());
    return () => { dispose(); root.replaceChildren(); };
  }, []);
  return <div ref={host} aria-label="Voidr Loops" />;
}
