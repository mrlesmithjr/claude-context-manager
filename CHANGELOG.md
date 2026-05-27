# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) at the patch level — all releases are patch increments until the feature set stabilizes.

> History before v0.8.108 is available in the git log: `git log --oneline`.

---

## [Unreleased]

---

## [0.8.108] - 2026-05-27

### Added
- `CONTEXT_MANAGER_CAPTURE_FLOOR` env var: configurable minimum importance score for observations (default 0.15, clamped to 0.0-0.65). Set to `0.0` to disable the floor entirely.

### Fixed
- Diagram and cross-link gaps in `ARCHITECTURE.md` and `README.md`.

---

## [0.8.107] and earlier

See `git log --oneline v0.8.107` for the full commit history prior to this changelog.

[Unreleased]: https://github.com/mrlesmithjr/claude-context-manager/compare/v0.8.108...HEAD
[0.8.108]: https://github.com/mrlesmithjr/claude-context-manager/compare/v0.8.107...v0.8.108
