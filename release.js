// Publishes a GitHub Release for the current desktop version with the built
// dist artifacts attached (portable exe + win zip). Dependency-free: talks to
// the GitHub REST API over https and reuses the SAME stored credential that
// `git push` uses (via `git credential fill`) — no gh CLI needed.
//
// Flow per update: bump versions -> CHANGELOG.md entry -> node desktop/build-dist.js
//                  -> commit + push -> node release.js
//
// The tag v<desktop-version> is created by the API on the default branch HEAD,
// so push the release commit BEFORE running this. Re-running for an existing
// release uploads only the missing assets (idempotent).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
const ext = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const OWNER = 'Andrecks';
const REPO = 'ASCII_Filter';

const dist = path.join(root, 'desktop', 'dist');
const assets = [
  { name: `ASCII-Shader-${version}-portable.exe`, type: 'application/octet-stream' },
  { name: `ASCII-Shader-${version}-win.zip`, type: 'application/zip' },
].map((a) => ({ ...a, path: path.join(dist, a.name) }));

for (const a of assets) {
  if (!fs.existsSync(a.path)) {
    console.error(`missing ${a.path}\nbuild first: node desktop/build-dist.js`);
    process.exit(1);
  }
}

// token from the credential store git itself uses (never printed)
function gitToken() {
  const out = execSync('git credential fill', {
    cwd: root, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n',
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('no stored github.com credential (git credential fill gave no password)');
  return m[1].trim();
}

function api(method, host, p, token, body, type) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const req = https.request({
      host,
      path: p,
      method,
      headers: {
        'User-Agent': 'ascii-shader-release',
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        ...(data ? { 'Content-Type': type || 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON error body */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// release notes = the newest section of CHANGELOG.md
function latestChangelog() {
  try {
    const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const sections = md.split(/^## /m);
    if (sections.length > 1) return '## ' + sections[1].trim();
  } catch { /* fall through */ }
  return 'See CHANGELOG.md';
}

(async () => {
  const token = gitToken();
  const created = await api('POST', 'api.github.com', `/repos/${OWNER}/${REPO}/releases`, token, {
    tag_name: tag,
    name: `ASCII Shader ${version}`,
    body: latestChangelog() + `\n\n_extension v${ext.version}_`,
  });
  let release = created.json;
  if (created.status === 422) {
    const got = await api('GET', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`, token);
    if (got.status !== 200) {
      console.error(`release ${tag} exists but fetch failed (${got.status}): ${got.raw.slice(0, 300)}`);
      process.exit(1);
    }
    release = got.json;
    console.log(`release ${tag} already exists — uploading missing assets`);
  } else if (created.status !== 201) {
    console.error(`create release failed (${created.status}): ${created.raw.slice(0, 500)}`);
    if (created.status === 403 || created.status === 404) {
      console.error('the stored git credential likely lacks API access to releases —');
      console.error('create a PAT with repo scope and store it for https://github.com');
    }
    process.exit(1);
  } else {
    console.log(`created release ${tag} (${release.html_url})`);
  }

  const existing = new Set((release.assets || []).map((a) => a.name));
  for (const a of assets) {
    if (existing.has(a.name)) {
      console.log(`  ${a.name} — already uploaded, skip`);
      continue;
    }
    const buf = fs.readFileSync(a.path);
    process.stdout.write(`  uploading ${a.name} (${(buf.length / 1048576).toFixed(1)} MB)... `);
    const up = await api('POST', 'uploads.github.com',
      `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(a.name)}`,
      token, buf, a.type);
    if (up.status !== 201) {
      console.log('FAILED');
      console.error(`  (${up.status}): ${up.raw.slice(0, 300)}`);
      process.exit(1);
    }
    console.log('ok');
  }
  console.log(`done -> https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
