import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { BrowserContext, Page } from 'playwright-core';
import { CONTROL_SELECTOR, type Observation } from './browser.js';

export async function credentialEvidence(page: Page, observation: Observation, secrets: Record<string, string> = {}) {
  if (!Object.keys(secrets).length) return observation;
  const controls = await Promise.all(observation.controls.map(async control => {
    if (!['input', 'textarea'].includes(control.tag)) return control;
    try {
      const value = await page.frames()[control.frame]?.locator(CONTROL_SELECTOR).nth(control.index).inputValue({ timeout: 1000 });
      const match = Object.entries(secrets).find(([, secret]) => secret && secret === value);
      return match ? { ...control, verifiedValue: `{{env.${match[0]}}}` } : control;
    } catch { return control; }
  }));
  return { ...observation, controls };
}

export function secretRedactor(secrets: Record<string, string> = {}) {
  const replacements = Object.entries(secrets).flatMap(([key, value]) => value
    ? [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)].map(encoded => [encoded, `{{env.${key}}}`] as const) : [])
    .sort((a, b) => b[0].length - a[0].length);
  const text = (value: string) => replacements.reduce((result, [secret, ref]) => result.split(secret).join(ref), value);
  const redact = <T>(value: T): T => {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map(redact) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
    return value;
  };
  return { text, redact };
}

export function resolveSecret(value: string, secrets: Record<string, string> = {}) {
  return value.replace(/\{\{env\.([^}]+)\}\}/g, (_, key: string) => {
    if (!secrets[key]) throw new Error(`Acesso de teste não configurado: ${key}.`);
    return secrets[key];
  });
}

export async function maskSecretFields(context: BrowserContext, secrets: Record<string, string>) {
  await context.addInitScript((values: string[]) => {
    const mask = () => {
      if (values.length && document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (parent && !['SCRIPT', 'STYLE'].includes(parent.tagName) && values.some(value => value && node.textContent?.includes(value))) {
            parent.style.setProperty('-webkit-text-security', 'disc', 'important');
          }
        }
      }
      document.querySelectorAll('input,textarea').forEach(element => {
        const field = element as HTMLInputElement;
        if (field.type === 'password' || values.some(value => value && field.value.includes(value))) {
          field.style.setProperty('-webkit-text-security', 'disc', 'important');
          field.setAttribute('data-voidr-secret', 'true');
        }
      });
    };
    document.addEventListener('input', mask, true);
    document.addEventListener('change', mask, true);
    new MutationObserver(mask).observe(document, { childList: true, subtree: true });
  }, Object.values(secrets));
}

export async function redactTrace(file: string, secrets: Record<string, string>, excludedOrigins: string[] = []) {
  if (!Object.keys(secrets).length && !excludedOrigins.length) return;
  const redact = secretRedactor(secrets).text;
  const entries = unzipSync(await readFile(file));
  const removed = new Set<string>();
  Object.entries(entries).filter(([name]) => name.endsWith('.network')).forEach(([name, bytes]) => {
    const lines = strFromU8(bytes).split('\n').filter(line => {
      if (!line.trim()) return false;
      const value = JSON.parse(line);
      const snapshot = value.snapshot;
      if (!snapshot?.request?.url || !excludedOrigins.some(origin => snapshot.request.url.startsWith(`${origin}/`))) return true;
      [snapshot.request.postData?._sha1, snapshot.response?.content?._sha1].filter(Boolean).forEach(sha => removed.add(`resources/${sha}`));
      return false;
    });
    entries[name] = strToU8(`${lines.join('\n')}\n`);
  });
  removed.forEach(name => { delete entries[name]; });
  const redacted = Object.fromEntries(Object.entries(entries).map(([name, bytes]) => {
    const binary = bytes.includes(0) || (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes[1] === 0x50);
    return [name, binary ? bytes : strToU8(redact(strFromU8(bytes)))];
  }));
  await writeFile(file, zipSync(redacted), { mode: 0o600 });
}
