# App Auto-Patch for Intune

A single-page configurator for deploying [App Auto-Patch](https://github.com/App-Auto-Patch/App-Auto-Patch) (AAP) to Macs with Microsoft Intune. Choose your settings in the browser and download everything Intune needs, ready to upload.

Everything runs locally in your browser. Nothing you type is sent anywhere.

## Use it

Open `index.html` in any browser, or turn on GitHub Pages for this repository and use the hosted copy. It is one self-contained file, so it also works offline.

1. **Install method.** Choose a platform script (downloads AAP from GitHub and checks its SHA-256 hash) or the release `.pkg`.
2. **Settings.** Pick a preset, or tick and set any of AAP's managed preferences. You can also import an existing `.plist`, `.mobileconfig` or Intune preference file.
3. **Profiles and reporting.** Optionally add the managed login item and swiftDialog notification payloads, and choose what the Intune custom attribute reports.
4. **Download all files (.zip)**, then follow the README inside the zip.

Use **Save config** to keep every choice as a JSON file, and **Load config** to restore it later or hand it to a colleague. The file carries a `schemaVersion`, so older saves keep loading as the settings list changes.

## What it generates

| File | Where it goes in Intune |
|---|---|
| `xyz.techitout.appAutoPatch.xml` | Devices › macOS › Configuration › Templates › **Preference file** (domain `xyz.techitout.appAutoPatch`) |
| `AppAutoPatch.mobileconfig` | Devices › macOS › Configuration › Templates › **Custom**. Use this *or* the preference file, not both. |
| `AAP-Intune-Installer.zsh` | Devices › Scripts and remediations › **Platform scripts** › macOS. Run as signed-in user: **No**. |
| `AAP-<value>.zsh` | Devices › macOS › **Custom attributes** (String) |
| `AAP-Uninstall.zsh` | Platform script, assigned only when you retire AAP |

The `.mobileconfig` and the preference file are configuration profiles, not scripts. Uploading one under Platform scripts fails with "The uploaded file is not a valid script".

## Built-in checks

The **Rollout plan** tab flags common mistakes before you assign anything, including:

- wildcards in `OptionalLabels`
- webhooks switched on without a URL
- monthly cadence without its schedule keys
- pre- and post-patch scripts saved outside `/Library/Management/AppAutoPatch/Hooks/`
- tokens and webhook URLs that local users can read
- a `main` ref, which breaks the hash check after the next upstream commit

## Input safety

Values you type end up inside shell scripts and XML, so they are checked before anything is generated:

- **Custom ref:** letters, digits, `.`, `-` and `_` only (a tag, branch or commit SHA). There's no `/` and no `..`.
- **SHA-256 hash:** exactly 64 hex characters.
- **Profile identifier prefix:** reverse-DNS form, for example `com.contoso`.

If a value fails, that file isn't generated and **Download all** is blocked, so nothing unsafe can be copied or downloaded. Settings loaded from browser storage or a config file are checked the same way.

The generated install script exits with AAP's own error code if the self-install fails, and fails if AAP or its LaunchDaemon is missing afterwards, so Intune reports the failure instead of a false success.

**Secrets.** `GitHubAPIToken` and the Teams, Slack and Google Chat webhook URLs are kept for the current visit only. They are never written to browser storage, and **Save config** leaves them out and lists them under `redacted`. They still go into the profile you download, because AAP needs them there.

## Version notes

- Tracks **AAP 3.7.7**. The installer defaults to the `Version_3.7.7` tag, with verified SHA-256 hashes for 3.7.3 to 3.7.7.
- From 3.7.7, ten settings are real booleans (`<true/>`/`<false/>`) instead of `TRUE`/`FALSE` strings. If you pin the installer to a release older than 3.7.7, the configurator automatically writes the five settings that older versions read only as strings (`ConvertAppsInHomeFolder`, `IgnoreAppsInHomeFolder`, `DialogOnTop`, `UseOverlayIcon`, `RemoveInstallomatorPath`) as strings.
- The settings list comes from AAP's own profile manifest (`Resources/Manifests`), so descriptions match upstream.

To pin a newer release, choose **Custom tag or commit** and paste its hash:

```sh
curl -sL https://raw.githubusercontent.com/App-Auto-Patch/App-Auto-Patch/Version_X.Y.Z/App-Auto-Patch-via-Dialog.zsh | shasum -a 256
```

## Tests

`tests/check.mjs` opens `index.html` in headless Chromium and checks every preset against every pinned release. It verifies that:

- the preference file, plist and `.mobileconfig` are well-formed
- the install script pins the right ref and hash
- booleans use the right form for each AAP version
- a config survives a save-and-load round trip
- the zip bundle is valid
- the generated scripts pass `zsh -n` (when zsh is installed) and the installer passes failures back to Intune
- hostile refs, hashes and prefixes block the affected files
- secrets never reach browser storage or config exports

```sh
npm install
npx playwright install chromium
npm test                     # offline checks
npm test -- --verify-hashes  # also re-downloads each pinned AAP script and checks its SHA-256
```

## Credits

App Auto-Patch is by the [App Auto-Patch team](https://github.com/App-Auto-Patch/App-Auto-Patch/blob/main/CONTRIBUTORS.md) and is MIT licensed. The generated install script is based on `AAP-Intune-Installer.zsh` by Andrew Spokes ([@TechTrekkie](https://github.com/TechTrekkie)). This configurator is an independent community tool and is not affiliated with the App Auto-Patch project or Microsoft.
