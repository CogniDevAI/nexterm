# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning where practical.

## [Unreleased]

### Added
- Persisted workspace snapshots keyed by stable identity (`profileId + userId`) so the app remembers the last active workspace per connection context.

### Changed
- Restored the active feature (`terminal`, `sftp`, or `tunnel`) when switching back to a previously used session workspace.
- Restored SFTP navigation context including local path, remote path, back/forward history, split position, and search state.
- Applied `startupDirectory` as the initial SFTP remote fallback when no saved workspace snapshot exists.

### Notes
- Live SSH handles, PTYs, and dead terminal processes are intentionally not persisted; only safe UI/workspace state is restored.
