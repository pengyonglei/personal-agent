const path = require('node:path');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'PersonalAgent',
    overwrite: true,
    // The main process is fully bundled; excluding pnpm's symlinked node_modules
    // also keeps Forge's dependency walker away from workspace-only build deps.
    prune: false,
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
      },
    },
  ],
};
