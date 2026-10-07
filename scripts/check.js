import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['server', 'client', 'scripts', 'tests'])
  for (const file of await readdir(directory))
    if (file.endsWith('.js')) {
      const r = spawnSync(process.execPath, ['--check', `${directory}/${file}`], {
        stdio: 'inherit',
      });
      if (r.status) process.exit(r.status);
    }
console.log('JavaScript syntax checks passed');
