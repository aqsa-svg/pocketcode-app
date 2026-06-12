# PocketCode — mobile app (Expo / React Native)

A native iOS/Android app for [PocketCode](../README.md): scan the QR your CLI
prints and control Claude Code from your phone — end-to-end encrypted, with
approve-from-phone and push notifications. Wire-compatible with the web viewer
and the Node host (same AES-256-GCM protocol).

## Run it (development)

```bash
cd mobile
npm install
npx expo start
```

Then open it on your phone with **[Expo Go](https://expo.dev/go)**:
scan the Expo dev QR with Expo Go (Android) or the Camera app (iOS).

In the app, tap **Scan QR code** and point it at the QR that `npx pocketcode`
prints on your computer. You're connected — encrypted, with approval cards.

> Tip: you can also **paste** the connect link instead of scanning.

## Build a standalone app

For a real installable build (and push notifications that work outside Expo Go):

```bash
npm install -g eas-cli
eas build --platform android   # or ios (needs an Apple Developer account)
```

## What's inside

- **App.js** — connect screen (QR scan + paste) and chat screen (events,
  approval cards, auto-reconnect, best-effort push registration).
- **lib/crypto.js** — pure-JS AES-256-GCM (`@noble/ciphers`), base64 + UTF-8
  helpers, and the connect-link parser. No native crypto module required.

## Notes

- Encryption uses the browser/host wire format `iv(12) || ciphertext || tag(16)`,
  base64 — verified to round-trip against the Node host.
- Push notifications use Expo's push service and are most reliable in a
  standalone/dev build (Expo Go support varies by SDK). In-app approvals work
  regardless.
