# Changelog

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
