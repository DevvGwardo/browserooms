import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Called by build_ntsc_wasm.sh after building the pinned, unmodified wrapper.
const wrapper = resolve(process.argv[2]);
const destination = new URL('../src/vendor/ntsc-rs/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['ntsc_rs_web_wrapper.js', 'ntsc_rs_web_wrapper.d.ts', 'ntsc_rs_web_wrapper_bg.wasm']) {
  await copyFile(resolve(wrapper, 'build', name), new URL(name, destination));
}
const { default: init, NtscSettingsList } = await import(pathToFileURL(resolve(wrapper, 'build/ntsc_rs_web_wrapper.js')));
await init({ module_or_path: await readFile(resolve(wrapper, 'build/ntsc_rs_web_wrapper_bg.wasm')) });
const list = new NtscSettingsList();
try {
  const descriptors = JSON.parse(list.getSettingsList());
  const defaults = JSON.parse(list.defaultPreset());
  await writeFile(new URL('default-settings.json', destination), JSON.stringify(defaults, null, 2) + '\n');
  await writeFile(new URL('settings.generated.ts', destination),
    '// Generated from the pinned WASM engine. Do not edit by hand.\n' +
    'import type { SettingDescriptor } from "./ntsc_rs_web_wrapper";\n\n' +
    `export const SETTINGS: SettingDescriptor[] = ${JSON.stringify(descriptors, null, 2)};\n\n` +
    `export const DEFAULT_SETTINGS = ${JSON.stringify(defaults, null, 2)} as const;\n` +
    'export type SettingId = Exclude<keyof typeof DEFAULT_SETTINGS, "version">;\n' +
    'export default SETTINGS;\n');
} finally {
  list.free();
}

const metadata = JSON.parse(execFileSync('cargo', ['+nightly-2025-12-26', 'metadata', '--locked',
  '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'], { cwd: wrapper, encoding: 'utf8' }));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of metadata.resolve.nodes.find(node => node.id === id).deps) {
    if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
  }
}
visit(metadata.resolve.root);
const packages = metadata.packages.filter(pkg => included.has(pkg.id));
const notices = new Map();
for (const pkg of packages) {
  let directory = dirname(pkg.manifest_path);
  let files = [];
  // Workspace crates (ntsc-rs and its macros) keep their notices at the repository root.
  for (let depth = 0; depth < 4 && !files.length; depth++) {
    files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)/i.test(entry.name))
      .map(entry => resolve(directory, entry.name));
    if (!files.length) directory = dirname(directory);
  }
  if (!files.length && pkg.name === 'hifijson' && pkg.version === '0.5.0') {
    files = [new URL('HIFIJSON_NOTICE.txt', destination)];
  }
  if (!files.length) throw new Error(`Missing licenses for ${pkg.name}`);
  for (const file of files.sort()) {
    const text = await readFile(file, 'utf8');
    const key = createHash('sha256').update(text).digest('hex');
    if (!notices.has(key)) notices.set(key, { packages: [], text });
    notices.get(key).packages.push(`${pkg.name} ${pkg.version}: ${typeof file === 'string' ? file.slice(directory.length + 1) : 'HIFIJSON_NOTICE.txt'}`);
  }
}
const rustSysroot = execFileSync('rustc', ['+nightly-2025-12-26', '--print', 'sysroot'], { encoding: 'utf8' }).trim();
await copyFile(resolve(rustSysroot, 'share/doc/rust/COPYRIGHT-library.html'), new URL('RUST_LIBRARY_COPYRIGHT.html', destination));
await copyFile(resolve(wrapper, 'LICENSE_MIT'), new URL('LICENSE_MIT', destination));
await copyFile(resolve(wrapper, 'LICENSE_APACHE'), new URL('LICENSE_APACHE', destination));
await copyFile(resolve(wrapper, 'Cargo.lock'), new URL('Cargo.lock', destination));
await writeFile(new URL('THIRD_PARTY_LICENSES.txt', destination),
  'Licenses for runtime crates and build-time macros. Identical license texts are grouped.\n\n' +
  [...notices.values()].map(notice => `${notice.packages.join('\n')}\n\n${notice.text}`).join('\n\n' + '='.repeat(80) + '\n\n'));
await writeFile(new URL('provenance.json', destination), JSON.stringify({
  wrapper: { repository: 'https://github.com/ntsc-rs/ntsc-rs-web', revision: '76283f541173ac636f5935001ecdae93f31bb480' },
  engine: { repository: 'https://github.com/ntsc-rs/ntsc-rs', revision: 'bddab2df789162391aa1981271a3d698a478f2e7' },
  rust: 'nightly-2025-12-26', target: 'wasm32-unknown-unknown', profile: 'release',
  wasmBindgen: '0.2.114', wasmOpt: false, sourceModifications: [],
  wasmSha256: createHash('sha256').update(await readFile(new URL('ntsc_rs_web_wrapper_bg.wasm', destination))).digest('hex'),
  dependencies: packages.map(pkg => ({ name: pkg.name, version: pkg.version,
    license: pkg.license ?? 'MIT OR Apache-2.0', source: pkg.source })),
}, null, 2) + '\n');
const distributedNotices = new URL('../public/licenses/ntsc-rs/', import.meta.url);
await mkdir(distributedNotices, { recursive: true });
for (const name of ['LICENSE_MIT', 'LICENSE_APACHE', 'THIRD_PARTY_LICENSES.txt', 'HIFIJSON_NOTICE.txt', 'RUST_LIBRARY_COPYRIGHT.html', 'provenance.json']) {
  await copyFile(new URL(name, destination), new URL(name, distributedNotices));
}
