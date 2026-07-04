# T3 Code mobile, from source

This fork ships working Android support and a free-Apple-ID iOS path for the T3 Code mobile app, plus a stack of mobile fixes. Upstream does not distribute the mobile app at all, so you build it yourself. This guide takes you from zero to the app on your phone, paired with your own server.

Everything here was validated end to end on a Pixel 7 (GrapheneOS) and an iPhone SE 2 against a self-hosted server. Build machine: Apple Silicon Mac. Linux works for the Android half.

## What this fork adds over upstream

- Android release builds actually work from a clean checkout (upstream main is broken outside their CI: Gradle 9 toolchain resolver crash + codegen props with no Android implementations, both patched here)
- Android: real terminal emulator (upstream ships a placeholder), Material 3 menus, Material You dynamic color, system dark mode (upstream forgot expo-system-ui), header toolbars and compose button (iOS-only APIs upstream, so Android had no way to create threads), voice dictation in the composer, syntax-highlighted code blocks, review diff surface, dark markdown tables
- Cross-platform: cold-start deep links no longer strand you on a single screen (Android back used to quit the app), plus the upstream mobile fix bundle (scroll jump after send, edge swipe-back, per-project quick compose, thread recency windows)
- iOS: free personal team builds (no paid developer account) via the T3CODE_IOS_PERSONAL_TEAM flow

## 0. Server

You need a T3 Code server somewhere your phone can reach. Any always-on box works:

```sh
npm install -g t3
t3 serve --host 0.0.0.0
```

Install and authenticate at least one provider CLI on that box first (`claude` and/or `codex login`). The server prints a pairing URL + token at startup. Tokens are one-time and expire in 5 minutes, so pair right after boot, or restart the server when you need a fresh one.

Reachability options, pick one:

- Same wifi: pair against `http://<lan-ip>:3773` and you are done (the app allows cleartext http)
- Tailscale (recommended): `t3 serve --tailscale-serve` gives you HTTPS on your tailnet with a valid cert, reachable from anywhere your phone runs Tailscale
- Your own reverse proxy / domain: anything terminating TLS in front of `127.0.0.1:3773` works

## 1. Clone and JS setup

```sh
git clone https://github.com/nnNyx/t3code
cd t3code
curl -fsSL https://vite.plus | bash   # installs vp (their toolchain wrapper)
vp i                                   # installs the pnpm workspace
```

## 2. Android

Prereqs (macOS: `brew install --cask temurin@21 android-commandlinetools`; Linux: JDK 21 + Android cmdline-tools per your distro):

```sh
export JAVA_HOME=$(/usr/libexec/java_home -v 21)   # macOS; point at JDK 21 on Linux
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
yes | sdkmanager --licenses
sdkmanager --install platform-tools
```

Build the preview variant (installable side by side with any future store version):

```sh
cd apps/mobile
APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 CI=1 node_modules/.bin/expo prebuild --clean --platform android
cd android
./gradlew assembleRelease "-Dorg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1536m"
```

First build downloads Gradle, the NDK, and SDK platforms; expect 10 to 20 minutes. Result:

```
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Install it over USB debugging (`adb install -r app-release.apk`) or sideload the file however you like. It is signed with the debug keystore, which is fine for personal use; keep the same checkout if you want in-place updates.

Gotchas we already fixed so you do not have to: the Gradle 9 foojay crash, the react-native-screens codegen failure, and always pass APP_VARIANT or you will silently build the production bundle id.

## 3. iOS (optional, free Apple ID)

Needs a Mac with Xcode (plus the iOS platform: `xcodebuild -downloadPlatform iOS`) and CocoaPods (`brew install cocoapods`). Sign into Xcode with any Apple ID (Settings, Accounts); the free Personal Team appears automatically.

```sh
cd apps/mobile
APP_VARIANT=preview T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.yourname.t3code \
EXPO_NO_GIT_STATUS=1 CI=1 node_modules/.bin/expo prebuild --clean --platform ios
```

Find your team id (10 characters):

```sh
defaults read com.apple.dt.xcodebuild IDEProvisioningTeamByIdentifier
```

Plug the phone in, trust the Mac, then build and install (get your device ids from `xcrun devicectl list devices`):

```sh
cd ios
xcodebuild -workspace T3CodePreview.xcworkspace -scheme T3CodePreview \
  -configuration Release -destination "id=<UDID>" \
  -derivedDataPath ./build -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAMID> CODE_SIGN_STYLE=Automatic build
xcrun devicectl device install app --device <COREDEVICE-ID> \
  build/Build/Products/Release-iphoneos/T3CodePreview.app
```

On the phone: enable Developer Mode when prompted (Settings, Privacy & Security, reboot), then trust your developer cert once (Settings, General, VPN & Device Management).

Free-team fine print: the install expires every 7 days (rerun the xcodebuild + install pair to renew), max 3 sideloaded apps, and widgets/push/Sign in with Apple are stripped because Apple will not sign them for free accounts.

## 4. Pair

Open the app, Add environment, then either scan the QR the server printed or type the host (`your.domain` or `http://<lan-ip>:3773`, plain hostnames are assumed https) and the pairing code. Your projects and threads appear, the composer picks any model your server-side CLIs are logged into, and every thread has a real terminal on the box behind it.

## Keeping up

Upstream moves fast and their own Android PR will eventually land. This fork rebases when that happens. If a build breaks after you pull, re-run `vp i` first (pnpm patches live in `patches/` and need a relink), then prebuild again.
