#!/usr/bin/env node
// Builds the extension for one browser into dist/<target>/:
//
//   node scripts/build-extension.mjs chrome
//   node scripts/build-extension.mjs firefox
//
// There's no bundling: extension/ already runs as-is in Chromium (load it
// unpacked straight from the repo), and the code itself feature-detects the
// few APIs that differ (see extension/lib/platform.js). This only copies the
// files and, for Firefox, rewrites the manifest. The version always comes
// from extension/manifest.json, which release-please keeps up to date.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "extension");

// Fixed forever once the add-on is on AMO - it's how Firefox recognises
// updates and keeps each user's storage.
const GECKO_ID = "browsersync@axelroman-dev";
// 140 (an ESR) is the first desktop release that understands
// data_collection_permissions, which AMO requires from new add-ons; on
// Android it came in 142. (The add-on itself is desktop-only - Firefox for
// Android has no bookmarks or history API - but AMO's linter checks both.)
const GECKO_MIN_VERSION = "140.0";
const GECKO_ANDROID_MIN_VERSION = "142.0";

// Release-tooling files that live in extension/ but never ship.
const ALWAYS_SKIPPED = ["version.txt", "CHANGELOG.md"];

const TARGETS = {
  chrome: {
    skip: [],
    manifest: (manifest) => manifest,
  },
  firefox: {
    // Only used through chrome.offscreen, which Firefox doesn't have.
    skip: ["offscreen"],
    manifest(manifest) {
      const { service_worker: script, ...background } = manifest.background;
      const permissions = manifest.permissions
        .filter((permission) => permission !== "offscreen" && permission !== "favicon")
        // The context menu's copy actions write from the background page
        // directly (see copyText in lib/contextMenu.js).
        .concat("clipboardWrite");
      const { minimum_chrome_version: _, ...rest } = manifest;
      return {
        ...rest,
        // Firefox has no MV3 service workers; the same module runs as an
        // event page instead.
        background: { ...background, scripts: [script] },
        permissions,
        browser_specific_settings: {
          gecko: {
            id: GECKO_ID,
            strict_min_version: GECKO_MIN_VERSION,
            // What leaves the device, as AMO categorizes it - all of it
            // end-to-end encrypted and sent only to the server the user
            // connects to (see PRIVACY.md).
            data_collection_permissions: {
              required: ["authenticationInfo", "bookmarksInfo", "browsingActivity", "personallyIdentifyingInfo"],
            },
          },
          gecko_android: { strict_min_version: GECKO_ANDROID_MIN_VERSION },
        },
      };
    },
  },
};

const targetName = process.argv[2];
const target = TARGETS[targetName];
if (!target) {
  console.error(`Usage: node scripts/build-extension.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(1);
}

const out = join(ROOT, "dist", targetName);
const skipped = new Set([...ALWAYS_SKIPPED, ...target.skip]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(SOURCE, out, {
  recursive: true,
  filter: (path) => !skipped.has(relative(SOURCE, path).split(sep).join("/")),
});

const manifest = JSON.parse(readFileSync(join(SOURCE, "manifest.json"), "utf8"));
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(target.manifest(manifest), null, 4)}\n`);
console.log(`Built ${targetName} ${manifest.version} -> ${relative(ROOT, out)}`);
