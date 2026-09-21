import { useLayoutEffect, useRef } from 'react';
import { mountJourney } from './renderer.js';
import markup from './original.html?raw';
import stylesheet from './original.css?inline';

const journeyStyles = new CSSStyleSheet();
journeyStyles.replaceSync(stylesheet);

export function LoopsWorkspace({ onRunning }: {
  onRunning: (running: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRunning });
  callbacks.current = { onRunning };
  useLayoutEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [journeyStyles];
    root.innerHTML = markup;
    const dispose = mountJourney(root, window.voidrCapture.journeys,
      running => callbacks.current.onRunning(running));
    return () => { dispose(); root.replaceChildren(); };
  }, []);
  return <div ref={host} aria-label="Voidr Loops" />;
}
