const path = require('node:path');
const { readdir, unlink } = require('node:fs/promises');

const electronMirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const packagedLocales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
const requestedVersion = process.env.PERSONAL_AGENT_RELEASE_VERSION?.trim() || '';
const normalizedVersion = requestedVersion.replace(/^v/iu, '');
const versionLabel = normalizedVersion ? `v${normalizedVersion}` : '';
const executableName = versionLabel ? `PersonalAgent-${versionLabel}` : 'PersonalAgent';
const setupExe = versionLabel
  ? `PersonalAgent-${versionLabel}-Setup.exe`
  : 'PersonalAgent-Setup.exe';

function removeUnusedElectronLocales(buildPath, _electronVersion, platform, _arch, callback) {
  if (platform !== 'win32') {
    callback();
    return;
  }
  const localesDirectory = path.join(buildPath, 'locales');
  void readdir(localesDirectory, { withFileTypes: true })
    .then((entries) =>
      Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() && entry.name.endsWith('.pak') && !packagedLocales.has(entry.name),
          )
          .map((entry) => unlink(path.join(localesDirectory, entry.name))),
      ),
    )
    .then(() => callback(), callback);
}

module.exports = {
  hooks: {
    readPackageJson: async (_forgeConfig, packageJson) => {
      if (!normalizedVersion) return packageJson;
      return { ...packageJson, version: normalizedVersion };
    },
  },
  packagerConfig: {
    asar: true,
    ...(normalizedVersion ? { appVersion: normalizedVersion } : {}),
    executableName,
    overwrite: true,
    // The main process is fully bundled; excluding pnpm's symlinked node_modules
    // also keeps Forge's dependency walker away from workspace-only build deps.
    prune: false,
    download: {
      mirrorOptions: {
        mirror: electronMirror,
      },
    },
    afterExtract: [removeUnusedElectronLocales],
    ignore: (filePath) => {
      const normalized = filePath.replace(/\\/g, '/');
      if (/^\/?node_modules(?:\/|$)/u.test(normalized)) return true;
      if (!path.isAbsolute(filePath)) return false;
      const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');
      return /^node_modules(?:\/|$)/u.test(relativePath);
    },
    extraResource: [path.resolve(__dirname, '../web/dist/client')],
    win32metadata: {
      CompanyName: 'personal-agent',
      FileDescription: 'Personal Agent desktop application',
      InternalName: 'PersonalAgent',
      OriginalFilename: `${executableName}.exe`,
      ProductName: 'Personal Agent',
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'PersonalAgent',
        authors: 'personal-agent',
        description: 'Local-first AI coding agent',
        setupExe,
        noDelta: true,
      },
    },
  ],
};
