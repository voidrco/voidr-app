const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { notarize } = require('@electron/notarize');

const iconExtension = process.platform === 'darwin' ? 'icns' : process.platform === 'win32' ? 'ico' : 'png';
const execFileAsync = promisify(execFile);
const appleSigningIdentity = process.env.APPLE_CODESIGN_IDENTITY;
const appleNotaryKeychainProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE;
const appleNotaryKeychain = process.env.APPLE_NOTARY_KEYCHAIN;
const publicRelease = process.env.VOIDR_PUBLIC_RELEASE === '1';

const releaseRequirements = {
  APPLE_CODESIGN_IDENTITY: appleSigningIdentity,
  APPLE_NOTARY_KEYCHAIN_PROFILE: appleNotaryKeychainProfile,
  APPLE_NOTARY_KEYCHAIN: appleNotaryKeychain,
};
const missingReleaseRequirements = Object.entries(releaseRequirements)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (publicRelease && missingReleaseRequirements.length > 0) {
  throw new Error(
    `Public Capture release requires: ${missingReleaseRequirements.join(', ')}`,
  );
}

const appleNotarization =
  appleNotaryKeychainProfile && appleNotaryKeychain
    ? {
        keychainProfile: appleNotaryKeychainProfile,
        keychain: appleNotaryKeychain,
      }
    : undefined;

module.exports = {
  packagerConfig: {
    asar: true,
    // Main, preload and renderer are self-contained bundles. Forge's dependency
    // walker does not understand npm workspace symlinks, so do not ask it to
    // prune the monorepo graph or copy development node_modules into the app.
    prune: false,
    ignore: [
      /(^|[/\\])node_modules([/\\]|$)/,
      /(^|[/\\])src([/\\]|$)/,
      /(^|[/\\])scripts([/\\]|$)/,
      /\.map$/,
      /(^|[/\\])(?:forge|tsup|vite|vitest)\.config\.(?:cjs|ts)$/,
      /(^|[/\\])tsconfig\.json$/,
    ],
    name: 'Voidr Capture',
    icon: path.join(__dirname, 'assets', `icon.${iconExtension}`),
    appBundleId: 'co.voidr.capture',
    appCategoryType: 'public.app-category.developer-tools',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'A Voidr usa o microfone somente quando você grava uma nota de voz durante uma captura.',
    },
    osxSign: appleSigningIdentity
      ? { identity: appleSigningIdentity, hardenedRuntime: true }
      : undefined,
    osxNotarize: appleNotarization,
    protocols: [{ name: 'Voidr Capture', schemes: ['voidr'] }],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, result) => {
      if (result.platform !== 'darwin' || appleSigningIdentity) return;
      for (const outputPath of result.outputPaths) {
        // Forge mutates the Electron binary and Info.plist while adding fuses
        // and ASAR integrity. Re-seal the complete local bundle afterwards.
        await execFileAsync('/usr/bin/codesign', [
          '--force',
          '--deep',
          '--sign',
          '-',
          path.join(outputPath, 'Voidr Capture.app'),
        ]);
      }
    },
    postMake: async (_forgeConfig, makeResults) => {
      if (!publicRelease || !appleNotarization) return makeResults;

      for (const result of makeResults) {
        if (result.platform !== 'darwin') continue;
        for (const artifact of result.artifacts) {
          if (path.extname(artifact).toLowerCase() !== '.dmg') continue;
          await notarize({ appPath: artifact, ...appleNotarization });
        }
      }

      return makeResults;
    },
  },
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // This requires shipping a purpose-built browser_v8_context_snapshot.bin.
      // Enabling it without that artifact makes Electron fail closed at boot.
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    }),
  ],
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'] },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        ...(appleSigningIdentity
          ? {
              'code-sign': {
                'signing-identity': appleSigningIdentity,
                identifier: 'co.voidr.capture.installer',
              },
            }
          : {}),
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'voidr_capture', authors: 'Voidr' },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: 'voidr-capture',
          productName: 'Voidr Capture',
          bin: 'Voidr Capture',
          categories: ['Development'],
        },
      },
    },
  ],
};
