---
"@justus/android": patch
"@justus/backend": patch
"@justus/core": patch
"@justus/web": patch
---

[user]: A phone with many photos shows all of them again, and new photos keep appearing, instead of the photo list going stale.

`photos.list` answers in pages of at most 48 KB of photo JSON (`next` names where the next page starts), so a big list no longer goes over ekrooh's 64 KB invoke header and fails. The web joins the pages (#1002).
