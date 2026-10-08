import { existsSync } from 'node:fs';

(function checkDevcontainer() {
  if (process.env._RACCOON_TOOLKIT_DEVCONTAINER_CHECK_DONE === '1') return;
  process.env._RACCOON_TOOLKIT_DEVCONTAINER_CHECK_DONE = '1';

  const inContainer = process.env.IN_DEVCONTAINER === '1' || existsSync('/.dockerenv');
  if (inContainer) return;
  if (process.env.SUPPRESS_DEVCONTAINER_WARNING === '1') return;
  if (process.env.CI === 'true' || process.env.CI === '1') return;

  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  process.stderr.write(
    `${yellow}Warning: this script is meant to run inside the toolkit devcontainer.${reset}\n` +
      `  Reopen this toolkit folder in its devcontainer and run the command again.\n` +
      `  (suppress with SUPPRESS_DEVCONTAINER_WARNING=1)\n`
  );
})();
