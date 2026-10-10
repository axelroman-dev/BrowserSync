# Changelog

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
