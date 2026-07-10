# Acceptance checklist -- s06-game-save

- [ ] Cloud save is implemented via PlayFab (already integrated for leaderboards), not a separate backend.
- [ ] Players have 3 named save slots.
- [ ] Saving and playing works offline, and syncs automatically once connectivity returns.
- [ ] Save conflicts between two devices that played the same slot offline are detected and resolved without silently losing progress on either device.
- [ ] Existing local PlayerPrefs saves are automatically migrated to the cloud system on first launch after the update, with no data loss.
- [ ] The integration pins to a PlayFab offline SDK version compatible with the minimum supported OS versions (iOS 13 / Android 8).
- [ ] A rollback plan exists for the migration that does not require forcing a new app update.
- [ ] (Nice-to-have) A manual "sync now" button is available in the pause menu.
- [ ] (Nice-to-have) A "last synced" timestamp is shown per save slot.
- [ ] (Nice-to-have) Each save file stays under 50KB.
- [ ] (Nice-to-have) The save file format is human-readable JSON.
