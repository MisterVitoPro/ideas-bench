I'm the lead on a Unity 2D roguelike we ship on mobile. Right now saves are entirely local -- PlayerPrefs plus a JSON file on-device, nothing synced anywhere.

I want to add cloud save so progress follows a player across devices. We already use PlayFab for leaderboards, so I want cloud save to go through PlayFab too rather than standing up a separate backend. Players should get 3 named save slots.

This has to work offline and sync automatically once connectivity comes back -- a lot of our players are on subways or planes when they play, so we can't assume a connection is available when someone saves.

Because saves can happen offline on two different devices, we need real conflict resolution -- if the same slot got played on two devices while both were offline, we cannot silently lose either device's progress. Whatever happens, it has to be a resolvable conflict, not a coin-flip overwrite.

On first launch after this update ships, existing players' local PlayerPrefs saves need to get migrated into the new cloud system automatically, with zero data loss -- these are real players with real progress, and I don't want a single support ticket about a lost run.

Some nice-to-haves: a manual "sync now" button in the pause menu for players who want to force it, a "last synced" timestamp shown next to each save slot, keeping each save file under 50KB so sync stays fast even on bad connections, and having the save format be human-readable JSON so our support team can actually look at a player's save file when debugging an issue.

Since you're asking about constraints on the technical side: our minimum supported OS versions are iOS 13 and Android 8, and PlayFab's offline SDK cache has known issues on exactly those OS versions that require pinning to a specific SDK version -- we can't just grab latest. And there's a business constraint too -- we've got a submission deadline for a featured placement on the App Store in three weeks, so whatever migration risk this introduces needs a rollback plan that doesn't require forcing everyone to update the app again.
