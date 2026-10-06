# Changelog

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
