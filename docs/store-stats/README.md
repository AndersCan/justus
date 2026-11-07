# Store stats

Play Console exports that show how the store listing performs. They let us compare listing changes before and after.

## What to drop

The store listing performance report from Play Console (visitors and acquisitions or conversion for the main store listing), exported as CSV and left unedited.

Nothing with personal data: no reviews, no user lists, no names. Aggregate counts only.

## File name

`<export date YYYY-MM-DD>-<Play's file name>`, for example `2026-11-07-<name Play gave the file>.csv`, so files sort by date. Never edit or rename columns.

## Public

This repo is public; files here are public once committed.

## How the team reads them

The newest CSV is compared with the earlier ones around each listing change.

The dates of listing changes are the release tags that follow a commit to `apps/android/fastlane/metadata/`:

```sh
git log --format='%h %ad %s' --date=short -- apps/android/fastlane/metadata
git tag --sort=creatordate --format='%(refname:short) %(creatordate:short)'
```

The findings go into a plan proposing the next listing change. There are no scripts.
