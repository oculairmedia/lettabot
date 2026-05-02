---
name: android-deploy
description: Build, install, and release the letta-mobile Android app (debug + release APKs, device install, GitHub release publish). Use whenever the user asks to build the app, make/install an APK, push a release, or run release verification gates.
---

# Android Deploy — letta-mobile

End-to-end build & deploy reference for the letta-mobile Android app so you don't have to rediscover it every session.

**Project root:** `/opt/stacks/letta-mobile`
**Android module root:** `/opt/stacks/letta-mobile/android-compose`
**Backend:** `https://letta2.oculair.ca`
**Public release tag scheme:** `v0.1.x`

> ALWAYS run gradle commands from `android-compose/`. Never from repo root.

---

## 0. One-time setup (per machine)

```bash
cd /opt/stacks/letta-mobile/android-compose
cp local.properties.example local.properties   # then edit sdk.dir
```

Required `JAVA_HOME` (export before any gradle invocation):

```bash
# Either Android Studio's bundled JBR:
export JAVA_HOME="/path/to/Android Studio/jbr"
# Or system JDK 17 (works on this server):
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
```

Prerequisites:
- Android SDK Platform 36 + Build-Tools 36
- Full JDK/JBR (NOT just a JRE — gradle needs `JAVA_COMPILER`)
- `local.properties` with correct `sdk.dir`

---

## 1. Quick build (debug APK)

```bash
cd /opt/stacks/letta-mobile/android-compose
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`

Faster sanity check (no APK, just compile):
```bash
./gradlew :app:compileDebugKotlin
```

---

## 2. Install to a connected device

```bash
# from android-compose/
./gradlew installDebug                    # build + adb install in one go

# or manually:
adb devices                               # confirm device authorized
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

If multiple devices are attached:
```bash
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 3. Recommended verification gates (before pushing)

```bash
cd /opt/stacks/letta-mobile/android-compose
./gradlew :app:compileDebugKotlin
./gradlew :app:testDebugUnitTest
./gradlew detekt
```

For shared model / repo / serialization changes, run the full stack in order:
```bash
./gradlew clean :core:compileDebugKotlin
./gradlew :designsystem:compileDebugKotlin
./gradlew :app:compileDebugKotlin
./gradlew :app:testDebugUnitTest
```

Sequentially — KSP state breaks if you overlap.

There's also a project-level Makefile wrapper at `/opt/stacks/letta-mobile/Makefile`:
```bash
make verify-build         # :app:compileDebugKotlin
make verify-unit-tests    # :app:testDebugUnitTest
make verify-all           # lint-telemetry + verify-sync + verify-stream (needs device + AGENT/CONV)
make verify-release       # full release-gate ledger via scripts/release/verify-release.sh
```

---

## 4. Release APK build

### 4a. Pick a tag

```bash
gh release list --limit 20
git tag --list "v0.1.*"
```
Choose a NEW `v0.1.x` tag — never reuse one. The internal `versionName`/`versionCode` in `app/build.gradle.kts` is independent of the GitHub tag.

### 4b. Signing inputs

Two options (prefer the first locally):

**Option A — `android-compose/keystore.properties`:**
```properties
storeFile=../letta-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```
- `storeFile` is resolved relative to `android-compose/app/`.
- `keystore.properties` and `*.jks` are gitignored.

**Option B — env vars:** `SIGNING_STORE_FILE`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`.

If you used a temporary keystore, mark the APK as **non-production-signing**.

### 4c. Build

```bash
cd /opt/stacks/letta-mobile/android-compose
./gradlew --stop
pkill -f kotlin-daemon 2>/dev/null || true
./gradlew cleanKotlinIC
./gradlew :app:assembleRelease
```

Output:
```
app/build/outputs/apk/release/app-release.apk
```

Verify:
```bash
ls app/build/outputs/apk/release
stat app/build/outputs/apk/release/app-release.apk
```

### 4d. Publish GitHub release

```bash
cd /opt/stacks/letta-mobile
gh release create v0.1.X \
  "android-compose/app/build/outputs/apk/release/app-release.apk#letta-mobile-v0.1.X-release.apk" \
  --target main \
  --title "v0.1.X" \
  --notes "## Summary
- short release summary

## Artifact
- letta-mobile-v0.1.X-release.apk"

gh release view v0.1.X --json tagName,name,url,assets
```

CI workflow `.github/workflows/android.yml` mirrors this: decodes `SIGNING_KEYSTORE_BASE64`, sets `SIGNING_*`, runs `./gradlew :app:assembleRelease --no-daemon --build-cache`, uploads artifact. If local fails, diff against the workflow first.

---

## 5. Device verification (optional but recommended)

Bootstrap a fresh device through the canonical flow:

```bash
cd /opt/stacks/letta-mobile
make verify-device-ready \
  DEVICE=<adb-serial> \
  APK=android-compose/app/build/outputs/apk/release/app-release.apk \
  BASE_URL=http://192.168.50.90:8289 \
  API_KEY=$LETTA_TOKEN \
  AGENT=<agent-id> \
  CONV=<conv-id>
```

Then run the gates:
```bash
make verify-sync   AGENT=<agent-id> CONV=<conv-id>
make verify-stream CONV=<conv-id> LETTA_TOKEN=$LETTA_TOKEN
```

`verify-sync` watches sync-drift over N iterations and fails if any sample isn't HEALTHY. `verify-stream` listens on resume-stream and fails if zero events arrive in `STREAM_TIMEOUT` (default 60s). Use `STREAM_SEND_TEXT="ping"` to auto-trigger a run.

---

## 6. Release checklist (every time)

1. `main` clean and up to date
2. Pick NEW `v0.1.x` tag (never reuse)
3. Confirm signing inputs present (keystore.properties or env)
4. Run the sequential release build flow (§4c)
5. Verify `app-release.apk` exists
6. Publish the GitHub release with the APK asset
7. Verify with `gh release view`
8. Document whether APK used production key or temp key

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Gradle: missing Android SDK | Install Platform 36 + Build-Tools 36 in Android Studio |
| Gradle: missing `JAVA_COMPILER` | `JAVA_HOME` must point at a full JDK/JBR, not a JRE |
| Gradle: cannot find SDK | Set `sdk.dir` in `android-compose/local.properties` |
| `.tab` file corruption (`source-to-classes.tab`, `lookups.tab`, etc.) | `./gradlew cleanKotlinIC` |
| Persistent IC corruption | `./gradlew --stop && pkill -f kotlin-daemon ; ./gradlew clean` |
| KSP flaky after dep changes | Always `clean` before compile |

The repo's `gradle.properties` keeps:
- `org.gradle.daemon=true` (validated stable: 60/60 clean runs, ~13× warm speedup)
- `org.gradle.parallel=false` (overlap caused Android verification failures)
- `org.gradle.caching=false` (cache packing caused failures)

CI passes `--no-daemon` explicitly — runners are ephemeral.

---

## 8. Module map (for orientation)

| Module | Purpose |
|--------|---------|
| `android-compose/app` | Screens, navigation, Hilt wiring, entrypoints |
| `android-compose/core` | Data models, Ktor API client, Room, repositories |
| `android-compose/designsystem` | Compose components, theme, `LettaIcons` |
| `android-compose/chat` | Streaming chat client (LettaChatClient primitive) |
| `android-compose/bot` | Embedded bot gateway support |
| `android-compose/cli` | Build/test CLI helpers |
| `android-compose/baselineprofile`, `macrobenchmark`, `perf` | Performance tooling |

---

## 9. Useful one-liners

```bash
# Build + install debug in one shot
( cd /opt/stacks/letta-mobile/android-compose && export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 && ./gradlew installDebug )

# Just rebuild after a Kotlin source tweak
( cd /opt/stacks/letta-mobile/android-compose && ./gradlew :app:assembleDebug )

# Sideload a built APK to default device
adb install -r /opt/stacks/letta-mobile/android-compose/app/build/outputs/apk/debug/app-debug.apk

# Tail device logs filtered to the app
adb logcat --pid=$(adb shell pidof com.letta.mobile)
```

---

## References inside the repo

- `android-compose/README.md` — canonical build/release doc (mirror this if it drifts)
- `Makefile` — release verification gates
- `docs/RELEASE.md`, `docs/RELEASE-AUTOMATION.md`, `docs/RELEASE-GATE-LEDGER.md`
- `scripts/release/bootstrap-device.sh`, `scripts/release/verify-release.sh`
- `.github/workflows/android.yml` — authoritative CI release flow
