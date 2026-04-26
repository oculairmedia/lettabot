# Off-LAN relay for letta-mobile ↔ lettabot

**Status:** Proposed (next-quarter)
**Date:** 2026-04-26
**Author:** PM - letta-mobile (Letta Code) + Emmanuel
**Related:** paseo deep dive
**Bead epic:** `lb-rly` (lettabot)

## Context

Today letta-mobile only works on the same LAN as the lettabot daemon. Off-LAN access requires Tailscale/WireGuard/port-forwarding — friction we've punted on for months. Paseo solves this with a small Cloudflare Worker that bridges two WebSockets, with E2EE so the relay can't read traffic. Their v2 design also supports multiple clients per daemon.

This document specifies a clean-room reimplementation. Code is **inspired by, not derived from**, paseo's AGPL implementation; the design is a synthesis of their approach plus our existing constraints (Letta-stateful agents, lettabot's WS gateway shape).

This is a **next-quarter** project. Doc exists now to capture the design while it's fresh; no implementation work is gated on it.

---

## Part 1: Requirements

### Must

- Phone connects to lettabot from anywhere (cellular, foreign WiFi).
- No port forwarding, no static IP, no Tailscale.
- E2EE: relay operator (us, on Cloudflare) can't read or modify message content.
- Multiple phones / desktop clients can connect to the same lettabot simultaneously.
- Survives daemon reconnect: phone doesn't have to restart when lettabot restarts.
- Frame ordering preserved per connection.

### Should

- Cheap: Cloudflare Workers free tier covers a single user comfortably; paid tier scales.
- Pluggable transport: ability to swap relay backend (Cloudflare DO → self-hosted Node → AWS) without client/daemon changes.
- Reasonable latency: relay round-trip < 100ms p50 globally.

### Won't (this iteration)

- Multi-tenant relay (one Cloudflare account per user, share later).
- File transfer optimization (route through relay; revisit if bandwidth becomes an issue).
- Voice/audio (separate channel, separate doc).

---

## Part 2: Topology

```
┌──────────────┐                     ┌────────────────────────────┐                     ┌──────────────┐
│  letta-mobile│   WSS (E2EE)        │ Cloudflare Durable Object  │   WSS (E2EE)        │   lettabot   │
│   (phone)    │ ─────────────────→  │  RelayDurableObject        │ ←─────────────────  │   (daemon)   │
│              │ ←─────────────────  │  per-session, hibernated   │ ─────────────────→  │              │
└──────────────┘                     └────────────────────────────┘                     └──────────────┘
        │                                                                                       │
        │  ECDH handshake (Curve25519) →                                                        │
        │  ← ECDH ack                                                                           │
        │  XSalsa20-Poly1305 ciphertext frames (relay sees only opaque blobs)                   │
        └───────────────────────────────────────────────────────────────────────────────────────┘
```

### Roles

- **Daemon** (lettabot): connects *outbound* to the relay. Holds one **control socket** + N **data sockets** (one per connected client).
- **Client** (phone, desktop): connects to the relay with a `connectionId` (UUID generated at first connect, persisted on device). Multiple client sockets can share one `connectionId` if reconnecting.
- **Relay** (Cloudflare DO): per-`serverId` Durable Object. Forwards bytes; never decrypts.

### Why split control + data sockets

When a client first connects, the relay needs to tell the daemon "open a data socket for connection-id X." If they shared one socket, that signaling would be inline and harder to scope. Split sockets:
- Control socket: long-lived, low-traffic, carries `{ type: "connected", connectionId }` and `{ type: "sync", connectionIds: [...] }` messages.
- Data sockets: one per active client connection, carry only opaque ciphertext frames.

This is paseo's v2 design and it's clean. We adopt it.

---

## Part 3: Protocol

### Session establishment

```
1. User pairs phone to daemon (out-of-band, e.g. QR code on local network OR
   manual paste of session secret). Phone learns: relay-url, server-id, daemon-pubkey.
2. Phone generates client-pubkey, persists keypair to keystore.
3. Phone opens WSS to wss://relay.example/?serverId=<id>&role=client&v=2
   Relay assigns connectionId, replies via control socket to daemon: { type: "connected", connectionId }.
4. Daemon opens WSS to wss://relay.example/?serverId=<id>&role=server&v=2&connectionId=<id>
   Relay pairs the two sockets.
5. Phone sends e2ee_hello { key: <client-pubkey> } over the (now plaintext) data socket.
6. Daemon replies e2ee_ready (no key — daemon's pubkey was learned at pairing).
7. Both sides derive shared key via ECDH.
8. From this point: every payload is encrypt(sharedKey, plaintext) → base64 over WS.
```

### Crypto

- **Key exchange**: Curve25519 (NaCl box).
- **Symmetric**: XSalsa20-Poly1305 with 24-byte nonces (NaCl secretbox-after).
- **Wire**: `[24-byte nonce][ciphertext]`, base64-encoded over WS text frames.
- **Replay protection**: monotonic nonce counter per direction; receiver rejects out-of-order beyond a small window.

Library: `tweetnacl-js` on the daemon (Node), `lazysodium-android` (or stdlib `javax.crypto` if NaCl bindings are too heavy) on Android. Same primitives, both well-audited.

### Reconnect semantics

- **Phone reconnects** (network change, app resume): same `connectionId`, new socket, new ECDH handshake (cheap). The daemon sees a new data socket bound to the same `connectionId` and resumes that connection's stream state.
- **Daemon reconnects** (process restart): control socket reconnects, relay sends `{ type: "sync", connectionIds: [active] }` so daemon re-opens a data socket for each. **In-flight frames are buffered by the relay** (up to 200 per connection, paseo-style).
- **Relay restart** (Durable Object hibernates and wakes): hibernation is transparent for active sockets; on cold-start any clients reconnect. We don't promise frame durability across DO eviction.

### Half-open detection

The relay can't reliably detect `ws.send()` failures from a hung daemon control socket — Cloudflare's WS implementation accepts writes even when the peer's TCP is dead. Paseo's heuristic (which we adopt):

- Every time a new client connects, the relay schedules a 10s probe: "did the daemon open the corresponding data socket?"
- If not: send a `sync` nudge over control.
- 5s later: if still no data socket, force-close the control socket. Daemon reconnects (it's listening for control-socket-closed events).

---

## Part 4: Component design

### Daemon side (`src/relay/`)

```
src/relay/
├── client.ts            # RelayClient: opens control + data sockets, manages reconnect
├── encrypted-channel.ts # E2EE wrap over a Transport
├── crypto.ts            # NaCl box / secretbox primitives + key persistence
├── transport.ts         # Transport interface (decouple from `ws` lib for testing)
└── client.test.ts
```

`RelayClient` exposes the same surface as a local WS gateway: `onMessage(handler)`, `send(connectionId, frame)`. The existing `ws-gateway.ts` doesn't know whether it's serving a LAN socket or a relay-routed socket — same envelope.

### Mobile side (`android-compose/bot/src/main/java/com/letta/mobile/bot/relay/`)

```
relay/
├── RelayClient.kt          # Connects to relay, manages reconnect
├── EncryptedChannel.kt     # E2EE wrap
├── Crypto.kt               # NaCl bindings (lazysodium or libsodium-jni)
├── KeyStore.kt             # AndroidKeystore-backed pair persistence
└── PairingFlow.kt          # QR code scan → store relay URL + serverId + daemon pubkey
```

`RelayClient` is a drop-in replacement for the existing LAN WS client when the user has paired with a remote daemon. The bot module already abstracts WS behind `WsBotClient`; adding a relay variant is a per-module concern, not a chat-screen change.

### Relay side (`relay-worker/`)

A separate npm package (could even be a separate repo). Cloudflare Worker + Durable Object.

```
relay-worker/
├── src/
│   ├── relay-do.ts          # RelayDurableObject
│   ├── router.ts            # Worker entry, parses serverId + role + connectionId
│   ├── frame-buffer.ts      # 200-frame buffer per connection
│   └── attachment.ts        # Per-socket attachment serialization
├── wrangler.jsonc
└── package.json
```

Deployed as one Worker globally; user creates their own Cloudflare account and `wrangler deploy`s. We provide the source + a `make deploy` target.

---

## Part 5: Pairing UX

The hard part. Off-LAN relay only works if the phone can learn:
1. Relay URL (`wss://relay.example`)
2. `serverId` (random per daemon)
3. Daemon public key (for ECDH)

### Two pairing modes

**a) On-LAN bootstrap** (preferred):
- Daemon advertises via mDNS on local network.
- Phone discovers, opens settings → "Pair with daemon" → QR with `{ relayUrl, serverId, daemonPubkey }`.
- One-time. After this the phone has everything to reach the daemon from anywhere.

**b) Manual paste**:
- User runs `lettabot pair --print` on the daemon machine.
- Outputs a single base64 token containing the same fields.
- Phone has a "Paste pairing token" field.

Both produce the same persisted state on the phone.

### Authorization

The pairing token doubles as a capability: anyone with it can connect to the daemon. Rotation: daemon regenerates `serverId` (new DO, old DO eventually evicted by Cloudflare) and the user re-pairs. Future iteration: per-client tokens with revocation list.

---

## Part 6: Phasing

This is a *big* project. Suggested phases, each independently shippable:

### Phase 1 — Daemon RelayClient + local relay server (3-5 days)

- Build `RelayClient` against a **dev relay server** running locally (no Cloudflare yet; same protocol).
- Goal: prove the daemon can connect *outbound* to a relay and that the existing gateway message flow works through it.
- Validation: round-trip messages between two local processes via the local relay.

### Phase 2 — Cloudflare Durable Object adapter (3-5 days)

- Port the local relay server logic to a Cloudflare DO.
- Wire up `wrangler` config, deployment scripts.
- Validation: daemon on home machine, dev test client on a different machine through CF.

### Phase 3 — E2EE handshake + crypto (2-3 days)

- Add NaCl handshake on daemon side.
- Plain-text mode still works behind a flag (for dev).
- Validation: relay observes only ciphertext; tampering with bytes breaks the connection cleanly.

### Phase 4 — Mobile RelayClient (5-7 days)

- Port `RelayClient` to Kotlin + Compose.
- Implement Android keystore-backed key persistence.
- Add QR-pairing flow (settings screen, camera, parse).
- Validation: phone on cellular, daemon at home, full chat works.

### Phase 5 — Multi-client + reconnect hardening (3-5 days)

- v2 multi-connection support (currently phase 1-4 can stop at v1 single-pair).
- Frame buffering, half-open probes.
- Validation: two phones to one daemon, kill daemon, restart, both reconnect with no message loss.

### Phase 6 — Production polish (3-5 days)

- Operational dashboards, key rotation, pairing-token rotation UX.
- Self-hosted relay path (for users who don't want Cloudflare).

**Total**: ~3-4 weeks of focused work for one engineer. Realistic calendar: 6-8 weeks with everything else in flight.

---

## Part 7: Tradeoffs and risks

### What we give up vs. Tailscale

- **Tailscale just works** for off-LAN. Zero-config WireGuard.
- We're rebuilding ~30% of what Tailscale gives us for free.
- **Why do it anyway**: lower friction for users (no separate app to install), browser/web client support (Tailscale won't work in a browser), explicit E2EE we control, fits within letta-mobile's existing pairing UX.

### What we give up vs. paseo's relay code

- AGPL prevents direct use. Reimplementing costs ~2 weeks vs. zero. **Acceptable cost** to keep our license freedom.
- Paseo is more battle-tested. We'll see edge cases they've already fixed.

### Risks

- **NaCl on Android**: bindings are fiddly. Spike `lazysodium-android` early to confirm no surprises.
- **Cloudflare DO cost at scale**: free tier comfortable for one user; paid tier ~$5/mo per 100k DO requests. If we get enterprise users, costs grow.
- **Mobile background reconnect**: Android's battery optimization will kill long-lived sockets when the app is backgrounded. Need either FCM-style wake (push) or accept that the phone reconnects when foregrounded. **Lean toward the latter** for v1.

---

## Part 8: Decision log

- **Cloudflare Durable Objects** chosen over self-hosted Node relay because: free tier suffices, hibernation is built-in, geo-distribution for free.
- **NaCl/tweetnacl** chosen over WebCrypto because: same library available on Android (lazysodium) and Node, simpler API surface than SubtleCrypto, well-audited.
- **Per-session DO** chosen over shared DO because: isolation, easier ops, no need for per-user auth at relay layer (the DO id *is* the auth).
- **Connection-id per phone** rather than per-session because: handles the "phone reconnects after network change" case without forcing daemon-side state churn.

---

## Open questions

- **Pricing model**: do we eat the relay cost ourselves (and limit per-user usage) or push users to BYO Cloudflare account? Probably BYO for technical users, hosted for casual users — defer the choice.
- **Relay-less fallback**: should the LAN path remain a first-class option, or do we deprecate it once relay ships? Keep LAN; relay is opt-in.
- **Audio/voice**: separate doc when we get there.
