#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function compareStableVersions(left, right) {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid stable version: ${value}`);
    return value.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function validateReleaseTransition(current, next) {
  if (compareStableVersions(current.version, next.version) >= 0) {
    throw new Error(
      `Capture version must increase before publishing (current ${current.version}, candidate ${next.version}).`,
    );
  }
}

const currentPath = argument('current');
const nextPath = argument('next');
if (!currentPath || !nextPath) {
  throw new Error('Usage: validate-release-transition.mjs --current=<manifest> --next=<manifest>');
}
const current = JSON.parse(await readFile(currentPath, 'utf8'));
const next = JSON.parse(await readFile(nextPath, 'utf8'));
validateReleaseTransition(current, next);
console.log(`Release transition ${current.version} → ${next.version} is valid.`);
