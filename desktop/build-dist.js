// Builds the standalone Windows distributable — a ready-to-run exe that needs
// NOTHING installed on the target PC (no Node.js, no npm).
//
// The app imports ../proto/* relative to desktop/, so we stage a copy of the
// repo structure (desktop/ + proto/ as siblings) and point electron-builder at
// the stage. asar stays OFF: PowerShell must read ocr-helper.ps1 from disk,
// koffi is a native module, and proto loads via plain file:// ES modules.
//
// Output in desktop/dist/:
//   ASCII-Shader-<ver>-portable.exe — single file, self-extracts on launch
//   ASCII-Shader-<ver>-win.zip      — unzip once, run "ASCII Shader.exe" (faster start)
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const desktop = __dirname;
const root = path.dirname(desktop);
const stage = path.join(desktop, 'dist-stage');
const out = path.join(desktop, 'dist');

// Self-bootstrap like start.cmd: on a fresh clone node_modules is absent, so
// install before staging (koffi is copied from node_modules into the stage,
// and electron-builder is the build tool itself).
if (!fs.existsSync(path.join(desktop, 'node_modules', 'electron-builder', 'package.json'))) {
  console.log('electron-builder not installed - running npm install...');
  execSync('npm install --no-audit --no-fund', { cwd: desktop, stdio: 'inherit' });
}

// Resolve the CLI entry from electron-builder's own bin field instead of
// hardcoding cli.js — the filename is the package's business, not ours.
const ebDir = path.join(desktop, 'node_modules', 'electron-builder');
const ebPkg = JSON.parse(fs.readFileSync(path.join(ebDir, 'package.json'), 'utf8'));
const ebBin = typeof ebPkg.bin === 'string' ? ebPkg.bin : ebPkg.bin['electron-builder'];
const ebCli = path.join(ebDir, ebBin);

const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const electronVersion = pkg.devDependencies.electron.replace(/^[~^]/, '');

console.log('staging -> ' + stage);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'desktop'), { recursive: true });

for (const f of ['main.js', 'preload.js', 'overlay.js', 'overlay.html', 'hotkeys.html', 'ocr-helper.ps1']) {
  fs.copyFileSync(path.join(desktop, f), path.join(stage, 'desktop', f));
}
fs.cpSync(path.join(root, 'proto'), path.join(stage, 'proto'), {
  recursive: true,
  filter: (src) => !/\.(jpg|jpeg|png)$/i.test(src), // proof screenshots not needed at runtime
});

fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'ascii-shader',
  productName: 'ASCII Shader',
  version: pkg.version,
  main: 'desktop/main.js',
  build: {
    appId: 'ascii.shader.desktop',
    productName: 'ASCII Shader',
    electronVersion,
    asar: false,
    npmRebuild: false,
    directories: { output: out },
    // koffi ships via extraResources so electron-builder's node_modules
    // pruning can't strip it. NOTE: the native .node lives in the SEPARATE
    // platform package @koromix/koffi-win32-x64 (koffi 3.x layout) — both are
    // required, missing the second one = "Cannot find the native Koffi module"
    extraResources: [{
      from: path.join(desktop, 'node_modules', 'koffi'),
      to: 'app/node_modules/koffi',
    }, {
      from: path.join(desktop, 'node_modules', '@koromix', 'koffi-win32-x64'),
      to: 'app/node_modules/@koromix/koffi-win32-x64',
    }],
    win: { target: ['portable', 'zip'] },
    portable: { artifactName: 'ASCII-Shader-${version}-portable.exe' },
    artifactName: 'ASCII-Shader-${version}-win.${ext}',
  },
}, null, 2));

console.log('building (electron-builder)...');
execFileSync(process.execPath,
  [ebCli, '--win', '--publish', 'never', '--projectDir', stage],
  { stdio: 'inherit' });

console.log('\ndone -> ' + out);
