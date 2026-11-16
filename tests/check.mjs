// Checks index.html in a headless browser and validates every generated file.
//   npm install && npm test              offline checks
//   npm test -- --verify-hashes          also downloads each pinned AAP script and checks its SHA-256
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

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
  applyPreset(preset, true);
  S.method = 'script'; S.ref = ref; S.hash = HASHES[ref] || ''; S.xLogin = true; S.xNotif = true;
  const parse = xml => !new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror');
  const pref = prefFile(), mc = mobileconfig(), inst = installScript();
  return {
    prefOk: parse(`<plist><dict>${pref}</dict></plist>`),
    plistOk: parse(prefPlist()),
    mcOk: parse(mc),
    mcHasDomain: mc.includes('<string>xyz.techitout.appAutoPatch</string>'),
    pref, inst, hash: HASHES[ref],
    bad: issues().filter(i => i[0] === 'bad').map(i => i[1]),
  };
}, [preset, ref]);

const presets = await page.evaluate(() => Object.keys(PRESETS));
const refs = await page.evaluate(() => Object.keys(HASHES).filter(r => r !== 'main'));
for (const preset of presets) {
  for (const ref of refs) {
    const r = await generate(preset, ref);
    const tag = `${preset} @ ${ref}`;
    check(r.prefOk && r.plistOk && r.mcOk, `${tag}: preference file, plist and .mobileconfig are well-formed XML`);
    check(r.mcHasDomain, `${tag}: .mobileconfig carries the AAP payload`);
    check(r.inst.includes(`GITHUB_REF="${ref}"`) && r.inst.includes(`HASH_CHECK="${r.hash}"`), `${tag}: install script pins ref and hash`);
    check(r.bad.length === 0, `${tag}: no blocking issues${r.bad.length ? ' (' + r.bad.join('; ') + ')' : ''}`);
    if (/<key>DialogOnTop<\/key>/.test(r.pref)) {
      const legacy = ref < 'Version_3.7.7';
      const ok = legacy ? /<key>DialogOnTop<\/key>\n<string>(TRUE|FALSE)<\/string>/.test(r.pref)
                        : /<key>DialogOnTop<\/key>\n<(true|false)\/>/.test(r.pref);
      check(ok, `${tag}: DialogOnTop written as ${legacy ? 'string (pre-3.7.7)' : 'boolean'}`);
    }
  }
}

// Config backup round trip.
const roundTrip = await page.evaluate(() => {
  applyPreset('monthly', true); S.ref = 'Version_3.7.6'; S.hash = HASHES['Version_3.7.6'];
  const before = prefFile() + installScript();
  const json = exportConfig();
  applyPreset('none', true); S.ref = 'Version_3.7.7';
  importConfig(JSON.parse(json));
  return before === prefFile() + installScript();
});
check(roundTrip, 'config export and import round-trips exactly');

// Zip bundle structure.
const zip = await page.evaluate(async () => {
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
