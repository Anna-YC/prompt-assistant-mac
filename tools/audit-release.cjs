'use strict';
// Prints finding locations only, never the private values used for comparison.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const { defaultConfig } = require('../lib/config');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const release = path.join(root, 'dist', version);
const archive = path.join(release, 'win-unpacked', 'resources', 'app.asar');
const reportPath = path.join(root, 'output', 'privacy', 'release-audit.json');
const findings = [];
const privateValues = new Set();
function remember(value) {
  if (typeof value === 'string' && value.length >= 8) privateValues.add(value);
}
function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const profile = process.env.RELEASE_AUDIT_PROFILE || path.join(process.env.APPDATA || '', '提示词助手');
const config = load(path.join(profile, 'config.json'));
const cache = load(path.join(profile, 'cache.json'));
if (config) {
  remember(config.baseToken); remember(config.baseUrl);
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(config.larkCliPath || '')) remember(config.larkCliPath);
  for (const source of config.sources || []) remember(source.tableId);
}
for (const item of [...(cache?.prompts || []), ...(cache?.phrases || [])]) {
  remember(item.recordId); remember(item.image?.fileToken); remember(item.video?.fileToken);
}
if (process.env.USERPROFILE) remember(process.env.USERPROFILE);
if (process.env.USERNAME) remember('Users\\' + process.env.USERNAME + '\\');
const checks = [
  ['github-credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{25,})\b/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['literal-secret', /(?:app_secret|appSecret|client_secret|clientSecret|access_token|refresh_token)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/],
  ['account-identifier', /\b(?:ou_|oc_)[a-f0-9]{24,}\b/],
];
function audit(scope, file, bytes) {
  for (const value of privateValues) {
    if (bytes.includes(Buffer.from(value)) || bytes.includes(Buffer.from(value, 'utf16le'))) {
      findings.push({ scope, file, kind: 'matches-local-private-data' }); break;
    }
  }
  if (/\.(?:js|cjs|json|html|css|md|ps1|bat|vbs|txt)$/i.test(file) || !path.extname(file)) {
    const text = bytes.toString('utf8');
    for (const [kind, pattern] of checks) if (pattern.test(text)) findings.push({ scope, file, kind });
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    if (emails.some(email => !/@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(email))) findings.push({ scope, file, kind: 'email-address' });
  }
  if (/\.png$/i.test(file) && bytes.readUInt32BE(0) === 0x89504e47) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) findings.push({ scope, file, kind: 'image-metadata-' + type });
      offset += 12 + size;
    }
  }
}
const sourceFiles = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean))];
for (const file of sourceFiles) {
  if (/(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|config\.json|cache\.json|stats\.json)$|\.(?:pem|p12|pfx)$/i.test(file)) findings.push({ scope: 'source', file, kind: 'private-file-name' });
  audit('source', file, fs.readFileSync(path.join(root, file)));
}
const packagedFiles = asar.listPackage(archive).map(file => file.replace(/^[\\/]+/, '').replaceAll('\\', '/')).filter(file => asar.statFile(archive, file).files === undefined);
for (const file of packagedFiles) {
  if (/^(?:cache|output|tools|\.git|\.agents|node_modules)(?:[/\\]|$)/.test(file) || /(?:^|[/\\])(?:config|cache|stats)\.json$/.test(file)) findings.push({ scope: 'package', file, kind: 'excluded-runtime-file' });
  audit('package', file, asar.extractFile(archive, file));
}
const defaults = defaultConfig();
if (defaults.baseToken || defaults.baseUrl || defaults.sources.length || defaults.phrases.local.length) findings.push({ scope: 'defaults', file: 'lib/config.js', kind: 'nonempty-user-defaults' });
const installer = path.join(release, `提示词助手 Setup ${version}.exe`);
const extractedArchive = path.join(root, 'output', 'privacy', version, 'payload', 'resources', 'app.asar');
const installerPayloadVerified = fs.existsSync(extractedArchive) && fs.readFileSync(extractedArchive).equals(fs.readFileSync(archive));
if (fs.existsSync(extractedArchive) && !installerPayloadVerified) findings.push({ scope: 'installer', file: 'resources/app.asar', kind: 'extracted-payload-mismatch' });
const report = {
  version, checkedAt: new Date().toISOString(), sourceFiles: sourceFiles.length,
  packagedFiles: packagedFiles.length, localPrivateValueChecks: privateValues.size,
  installerSha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
  installerPayloadVerified, gitHistoryIncluded: false, findings, passed: findings.length === 0,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
