const path = require('node:path');
const { readdir, unlink } = require('node:fs/promises');

const electronMirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const packagedLocales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);

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
  packagerConfig: {
    asar: true,
    executableName: 'PersonalAgent',
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
      OriginalFilename: 'PersonalAgent.exe',
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
        setupExe: 'PersonalAgent-Setup.exe',
        noDelta: true,
      },
    },
  ],
};
