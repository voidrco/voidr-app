import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/capture-desktop-release.yml', import.meta.url)),
  'utf8',
);
const publishWorkflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/capture-desktop-publish.yml', import.meta.url)),
  'utf8',
);
const publisher = readFileSync(
  fileURLToPath(new URL('../../scripts/publish-release.mjs', import.meta.url)),
  'utf8',
);
const preparer = readFileSync(
  fileURLToPath(new URL('../../scripts/prepare-release.mjs', import.meta.url)),
  'utf8',
);

describe('Capture macOS release policy', () => {
  it('builds signed and notarized artifacts for staging and production', () => {
    expect(workflow).toContain('channel: [staging, production]');
    expect(workflow).toContain('VITE_VOIDR_CAPTURE_CHANNEL: ${{ matrix.channel }}');
    expect(workflow).toContain('spctl --assess --type execute');
    expect(workflow).toContain('xcrun stapler validate');
  });

  it('publishes staging under the installer channel consumed by staging service', () => {
    expect(preparer).toContain("channel === 'staging' ? path.join('capture', 'preview') : 'capture'");
  });

  it('refuses to publish a macOS DMG without Developer ID and notarization gates', () => {
    expect(publisher).toContain("'/usr/bin/codesign'");
    expect(publisher).toContain("'/usr/sbin/spctl'");
    expect(publisher).toContain("'/usr/bin/xcrun'");
    expect(publisher).toContain("['stapler', 'validate', dmg.source]");
  });

  it('publishes a complete release after a merge into the production branch', () => {
    expect(publishWorkflow).toContain("github.ref_name == github.event.repository.default_branch");
    expect(publishWorkflow).toContain('needs: [macos-arm64, windows-x64]');
    expect(publishWorkflow).toContain('assemble-release.mjs');
    expect(publishWorkflow).toContain('validate-release-transition.mjs');
    expect(publishWorkflow).toContain('gs://${BUCKET}/capture/latest.json');
    expect(publishWorkflow.indexOf('cp "${source}"')).toBeLessThan(
      publishWorkflow.lastIndexOf('cp release/capture/latest.json'),
    );
  });

  it('keeps channel-specific build configuration out of channel contract tests', () => {
    expect(publishWorkflow).not.toMatch(
      /env:\n\s+VITE_VOIDR_CAPTURE_CHANNEL: production\n\s+CSC_IDENTITY_AUTO_DISCOVERY/,
    );
    expect(publishWorkflow.match(/VITE_VOIDR_CAPTURE_CHANNEL: production/g)).toHaveLength(2);
  });
});
