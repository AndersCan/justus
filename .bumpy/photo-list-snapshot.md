---
"@justus/backend": patch
"@justus/core": patch
"@justus/web": patch
---

`photos.list` pages after the first are cut from the list page one read (`listId`), so a photo deleted between pages no longer pushes another out of the gallery, and a load reads the store once instead of once per page. A `next` that does not move forward now fails the load instead of quietly showing only page one.
