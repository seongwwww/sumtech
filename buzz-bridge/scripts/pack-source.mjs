import { readFile, mkdir, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { windowsPowerShellEnv } from '../windows-env.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function packSource(output = resolve(root, 'buzz-bridge/dist/buzz-bridge-source.zip')) {
  const manifest = JSON.parse(await readFile(resolve(root, 'buzz-bridge/delivery.seed.json'), 'utf8'));
  const supporting = manifest.supporting_artifacts ?? [];
  const allowedSupporting = new Set(['README.md', 'AGENTS.md', 'paseo.json', '.gitattributes', '.gitignore']);
  if (!Array.isArray(supporting) || supporting.some((path) => !allowedSupporting.has(path))) throw new Error('Unsafe supporting artifact.');
  const stage = await mkdtemp(join(tmpdir(), 'buzz-source-'));
  try {
    for (const path of manifest.expected_artifacts) {
      if (!path.startsWith('buzz-bridge/') || path.includes('..')
        || /(?:node_modules|identity|dist\/|config\/local\.json|\.local\.json)/i.test(path)
        || (/\.env/i.test(path) && path !== 'buzz-bridge/.env.example')) throw new Error('Unsafe source artifact.');
      const target = resolve(stage, path);
      if (relative(stage, target).startsWith('..')) throw new Error('Unsafe source target.');
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(root, path), target);
    }
    for (const path of supporting) await copyFile(resolve(root, path), resolve(stage, path));
    await mkdir(dirname(output), { recursive: true });
    execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [string[]]$paths=ConvertFrom-Json -InputObject $env:BUZZ_SOURCE_PATHS; Compress-Archive -LiteralPath $paths -DestinationPath $env:BUZZ_SOURCE_OUTPUT -Force"],
      { env: { ...windowsPowerShellEnv(), BUZZ_SOURCE_PATHS: JSON.stringify([join(stage, 'buzz-bridge'), ...supporting.map((path) => join(stage, path))]), BUZZ_SOURCE_OUTPUT: output }, windowsHide: true, stdio: 'pipe' });
    const bytes = await readFile(output);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(`${output}.sha256`, `${sha256}  buzz-bridge-source.zip\n`);
    return { output, sha256, files: manifest.expected_artifacts.length + supporting.length };
  } finally {
    if (dirname(stage) !== resolve(tmpdir()) || !stage.split(/[\\/]/).at(-1).startsWith('buzz-source-')) throw new Error('Unexpected staging directory; cleanup refused.');
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await packSource()));
}
