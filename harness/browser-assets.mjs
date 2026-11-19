import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';

const legacyFiles = [
  'index.html', 'app.js', 'style.css', 'observer.js', 'export-dialog.js', 'usage.js',
  'progress.js', 'progress-view.js', 'removal-dialog.js', 'route-diagnostics.js', 'proposal-editor.js',
  'terminal-request.js', 'draft-copy-dialog.js',
];
const contentTypes = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],
  ['.css', 'text/css'], ['.svg', 'image/svg+xml'],
]);
const assetPath = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:html|js|mjs|css|svg)$/;

export async function loadBrowserAssets(root, mode = 'legacy') {
  if (!['legacy', 'experience'].includes(mode)) throw Error('The workspace UI mode is invalid.');
  const directory = join(root, mode === 'experience' ? 'web-experience' : 'web');
  const assets = new Map();
  if (mode === 'legacy') {
    await Promise.all(legacyFiles.map(async file => {
      assets.set(file === 'index.html' ? '/' : '/' + file, {
        data: await readFile(join(directory, file)), type: contentTypes.get(extname(file)),
      });
    }));
    return {mode, assets};
  }

  const manifest = JSON.parse(await readFile(join(directory, 'asset-manifest.json'), 'utf8'));
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > 64) throw Error('The workspace UI manifest is invalid.');
  for (const {file, sha256} of manifest) {
    if (typeof file !== 'string' || !assetPath.test(file) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
      throw Error('The workspace UI manifest contains an invalid entry.');
    const route = file === 'index.html' ? '/' : '/' + file;
    if (assets.has(route)) throw Error('The workspace UI manifest has a duplicate entry.');
    const data = await readFile(join(directory, file));
    if (createHash('sha256').update(data).digest('hex') !== sha256) throw Error('A workspace UI asset does not match the reviewed build.');
    assets.set(route, {data, type: contentTypes.get(extname(file))});
  }
  if (!assets.get('/')?.data.includes('<meta name="cydeworks-adapter" content="http">') || !assets.has('/app.js'))
    throw Error('The workspace UI build is incomplete.');
  return {mode, assets};
}
