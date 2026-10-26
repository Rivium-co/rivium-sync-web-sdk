# Changelog

## 0.3.0

### Breaking

- `set(data)` now replaces the document (fields you leave out are removed).
  Before, it merged. To keep merging, pass `{ merge: true }`:
  `doc.set(data, { merge: true })`. The same option works in
  `batch.set(ref, data, { merge: true })`.
- `doc.get()` now returns the document (`{ id, data, version, ... }`), as its
  type always said. Before, it returned the server's answer around it, so
  the fields were at `doc.data.data`. Code that read `doc.data.data` reads
  `doc.data` now. `add()` and query results always return the document
  itself too.
- With offline persistence on, the cache now stands in only when the server
  cannot be reached (no network, timeouts, 401 while the user token is
  refreshed, 408, 429, 5xx). When the server refuses a request
  (your Security Rules, invalid data), the error is thrown: `get()` and
  queries no longer answer from the cache, and `add()`, `set()`, `update()`
  and `delete()` no longer queue the write to retry later.
- `disconnect()` / `goOffline()` now also take the SDK offline for reads and
  writes right away: writes made after it are queued (and sent after
  `reconnect()`), reads come from the cache.

### Added

- Listeners are checked by your Security Rules on the server, like a `get()`
  or a query, and only receive the changes they are allowed to read. The
  first callback is the current data.
- Listener errors: `onSnapshot` takes an error callback
  (`doc.onSnapshot(callback, onError)`, `query.onSnapshot(callback, onError)`,
  `collection.onSnapshot(callback, options, onError)`). It is called when the
  rules refuse the listener, or stop it later because they no longer allow it
  (`listener_revoked`). The listener then delivers nothing more.
- `RiviumSyncError` has `reason`, `fields` and `status`. A query the rules
  cannot allow fails with `reason: 'query_not_allowed'` and `fields` names
  the filters to add, for `get()` and for listeners. New codes:
  `QUERY_NOT_ALLOWED`, `LISTENER_REVOKED`, `PERMISSION_DENIED`,
  `TOO_MANY_LISTENERS`.
- `RiviumSyncError.statusCode`: the HTTP status of the server's answer
  (`undefined` when there was none). Every failed document read or write now
  throws a `RiviumSyncError` with it: `PERMISSION_DENIED` (403),
  `DOCUMENT_NOT_FOUND` (404), else `DATA_FETCH_FAILED`, `DATA_WRITE_FAILED`,
  `DATA_DELETE_FAILED` or `QUERY_EXECUTION_FAILED`. A batch error carries it
  too.
- `onDocumentRejected((documentId, operation, error) => ...)`: a write made
  offline that the server refuses when it is sent is dropped, not retried, and
  the local copy goes back to the server's (a refused new document
  disappears). Writes queued by an earlier version are handled the same way.
- New exported types: `SetOptions`, `ListenerErrorCallback`,
  `RiviumSyncErrorReason`, `RiviumSyncErrorOptions`, `WriteOperation`,
  `DocumentRejectedListener`.

### Fixed

- `maxSyncRetries` is deprecated and has no effect (it never had one in this SDK): writes are retried until they go through, and refused ones are
  rolled back.
- Every realtime reconnect logs in with a fresh connection token. Before, a
  reconnect more than 24 hours after the first connection was refused, and
  after the reconnect attempts ran out realtime stayed down. A failed token
  request is retried instead of ending realtime.
- `offset()` was ignored by queries.
- Collection listeners received a document with the id `changes` and got
  every change twice.
- Deleted documents stayed in collection listener results.
- A query refused by the rules no longer returns cached results instead of
  the error.
- Realtime always uses a secure WebSocket.
- Deleting a document that is already gone succeeds instead of failing.
- A document created offline and then changed offline is created once when
  the writes are sent, instead of twice.
- Cached results used when the server cannot be reached apply the query's
  filters, order and limit, as they already did offline.
- With offline persistence off, writes made while the browser is offline fail
  with an error instead of being dropped without one.
- Going back online after `disconnect()` no longer reconnects by itself; call
  `reconnect()`.

## 0.2.2

- Every request to the Sync API now carries `X-Rivium-SDK: web/<version>`,
  so the Console can show which SDK and version a project uses. Realtime
  (MQTT) is unchanged. Exported `SDK_NAME` / `SDK_VERSION`.

## 0.2.1

- The SDK can be created before sign-in when user tokens are required:
  realtime waits for a token and then connects (`isAwaitingUserToken`,
  `onAwaitingUserToken`).
- Added `setUserToken()` and `refreshUserToken()`. A token for a different
  user reconnects as that user.
- `tokenProvider` may return `null` when no one is signed in.

## 0.2.0

- Added `tokenProvider` and `userToken` so Security Rules can trust `auth.uid`.
  Your server mints a short-lived token; the SDK sends it and refreshes it
  before it expires.
- Fixed `disconnect()` immediately reconnecting, which left a new WebSocket
  behind on every call.
- Realtime topics are now scoped per project. Requires the current API.

## 0.1.0

- First release.
