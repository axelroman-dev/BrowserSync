# Changelog

## [2.4.2](https://github.com/axelroman-dev/BrowserSync/compare/v2.4.1...v2.4.2) (2026-10-25)


### Bug Fixes

* **server:** upgrade zod to 4 (GHSA-mrhx-c7xc-m3w5) ([#28](https://github.com/axelroman-dev/BrowserSync/issues/28)) ([34c6709](https://github.com/axelroman-dev/BrowserSync/commit/34c67097f41eb51b13f77eb18cc1eff75ea0260a))

## [2.4.1](https://github.com/axelroman-dev/BrowserSync/compare/v2.4.0...v2.4.1) (2026-10-25)


### Bug Fixes

* **server:** move to Node 24 for the October 2026 security release, patch body-parser and proxy-addr ([#26](https://github.com/axelroman-dev/BrowserSync/issues/26)) ([c6b5a60](https://github.com/axelroman-dev/BrowserSync/commit/c6b5a606e34524e8921bf8ae24aeedc998f72fb3))

## [2.4.0](https://github.com/axelroman-dev/BrowserSync/compare/v2.3.0...v2.4.0) (2026-10-17)


### Features

* delete the account from the server dashboard, show the server version there, clearer proxy errors ([#23](https://github.com/axelroman-dev/BrowserSync/issues/23)) ([ba4f8c8](https://github.com/axelroman-dev/BrowserSync/commit/ba4f8c8b99e13bbbb694bf3bb39ad94f0a210e03))

## [2.3.0](https://github.com/axelroman-dev/BrowserSync/compare/v2.2.0...v2.3.0) (2026-10-16)


### Features

* change the account password, Lock now on the Sync tab and onboarding/logout fixes ([#20](https://github.com/axelroman-dev/BrowserSync/issues/20)) ([12ef3ef](https://github.com/axelroman-dev/BrowserSync/commit/12ef3ef19c1804c7a3418578563cf60990194506))
* in-page menu as wide as the field, open on focus, add an account from it ([#22](https://github.com/axelroman-dev/BrowserSync/issues/22)) ([29b31a2](https://github.com/axelroman-dev/BrowserSync/commit/29b31a26341542c633399fbbd16889cdac2c94fe))

## [2.2.0](https://github.com/axelroman-dev/BrowserSync/compare/v2.1.0...v2.2.0) (2026-10-13)


### Features

* passwords tab in the popup, remembered server URL and a richer Sync tab ([#17](https://github.com/axelroman-dev/BrowserSync/issues/17)) ([cb8df34](https://github.com/axelroman-dev/BrowserSync/commit/cb8df345c973376d76828f40bb8a9f1bd088c6b8))
* Settings tab in the popup and a redesigned password generator ([#19](https://github.com/axelroman-dev/BrowserSync/issues/19)) ([48b2654](https://github.com/axelroman-dev/BrowserSync/commit/48b26548fdf2bb3c23ac76f5d81f0d20f88b4a98))

## [2.1.0](https://github.com/axelroman-dev/BrowserSync/compare/v2.0.0...v2.1.0) (2026-10-10)


### Features

* bottom tab bar in the popup (Sync / Generator) ([#16](https://github.com/axelroman-dev/BrowserSync/issues/16)) ([089c81f](https://github.com/axelroman-dev/BrowserSync/commit/089c81f4a952cc9c12d27b2a55504db6b8ea8084))
* configurable password generator (characters or EFF word passphrases) ([#15](https://github.com/axelroman-dev/BrowserSync/issues/15)) ([34d06de](https://github.com/axelroman-dev/BrowserSync/commit/34d06de5c136fb88a9428d5a49976ceca531483f))
* opt-in autofill and right-click menu for saved passwords ([#13](https://github.com/axelroman-dev/BrowserSync/issues/13)) ([63118c8](https://github.com/axelroman-dev/BrowserSync/commit/63118c85a74dec589badef1931d4349e5fba5db4))
* **server:** seed a local-only development account ([#14](https://github.com/axelroman-dev/BrowserSync/issues/14)) ([7b2e7d2](https://github.com/axelroman-dev/BrowserSync/commit/7b2e7d25a1a543d3e2c32710173bc0c60b670e8a))


### Bug Fixes

* explain closed sessions and reopen the popup on "Log in" ([#11](https://github.com/axelroman-dev/BrowserSync/issues/11)) ([85c1899](https://github.com/axelroman-dev/BrowserSync/commit/85c1899a5d75ee7eaf681052b0257cfc4ff86009))

## [2.0.0](https://github.com/axelroman-dev/BrowserSync/compare/v1.3.0...v2.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* the extension now rejects servers whose /api/health doesn't report service "browsersync" and a compatible apiVersion, which includes every server before this release. Update the server together with the extension.

### Features

* add "Never" option to the save-password prompt ([#7](https://github.com/axelroman-dev/BrowserSync/issues/7)) ([4352879](https://github.com/axelroman-dev/BrowserSync/commit/4352879b4eca04650f06afa07bfbd8ce7f3eb6ca))
* add TOTP two-step verification codes to saved passwords ([#9](https://github.com/axelroman-dev/BrowserSync/issues/9)) ([6825514](https://github.com/axelroman-dev/BrowserSync/commit/6825514dec10c80929ecb894ac4a3bb922c47eb5))
* server-first connect step with health/version validation ([#10](https://github.com/axelroman-dev/BrowserSync/issues/10)) ([bb4f112](https://github.com/axelroman-dev/BrowserSync/commit/bb4f112cc48498e0d7ffb4be5984da72d9eecc4c))

## [1.3.0](https://github.com/axelroman-dev/BrowserSync/compare/v1.2.0...v1.3.0) (2026-09-24)


### Features

* add backup export/import, settings page and account management in dashboard ([#4](https://github.com/axelroman-dev/BrowserSync/issues/4)) ([c57eb76](https://github.com/axelroman-dev/BrowserSync/commit/c57eb76f979a00c0c2e0ea41c595dcf66c63d072))

## [1.2.0](https://github.com/axelroman-dev/BrowserSync/compare/v1.1.0...v1.2.0) (2026-09-24)


### Features

* add end-to-end encrypted password vault with in-page suggestions ([#1](https://github.com/axelroman-dev/BrowserSync/issues/1)) ([54b7a95](https://github.com/axelroman-dev/BrowserSync/commit/54b7a959acea34b4bfd2e0e74c480620b363dee1))
* **extension:** rename extension to "BrowserSync - Self-Hosted" ([0b1fdd6](https://github.com/axelroman-dev/BrowserSync/commit/0b1fdd6d640e255b72094c99ac30060d782554e1))
* **server:** Add landing page in server root ([fe0551a](https://github.com/axelroman-dev/BrowserSync/commit/fe0551a37add5415513ef2fc0cc28a8f80b8748d))
