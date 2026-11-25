#!/bin/bash
# Build and deploy a Capacitor app. Nothing here is specific to one app:
# paths and names come from `npx cap config --json`, the scheme from the
# Xcode project's target, the bundle ID and team from what Xcode builds.
#
#   ./tools.sh iphone <device-id>   build (Debug) and install on a USB-connected iPhone
#   ./tools.sh ios                  archive (Release) and upload to App Store Connect
#   ./tools.sh android <path>       build a debug APK and copy it to <path> (file or directory)
#
# Device IDs: `./tools.sh iphone` with none lists them (the Target ID column).

set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")"

usage() {
  sed -n '6,8s/^# //p' "$0" >&2
  exit 1
}

# json <json> <dotted.key>: print one value from a JSON string.
json() {
  node -e 'let v = JSON.parse(process.argv[1]);
    for (const k of process.argv[2].split(".")) v = v[k];
    console.log(v);' "$1" "$2"
}

web() {
  npm run build
  npx cap copy "$1"
}

ios_setup() {
  local cap xcodeproj
  cap="$(npx cap config --json)"
  xcodeproj="$(json "$cap" ios.nativeXcodeProjDirAbs)"
  # CocoaPods projects must be built through their workspace.
  if [ "$(json "$cap" ios.packageManager)" = SPM ]; then
    container=(-project "$xcodeproj")
  else
    container=(-workspace "$(json "$cap" ios.nativeXcodeWorkspaceDirAbs)")
  fi
  # The project also lists a scheme per plugin; the app's is named after its
  # target. (Capacitor's own ios.scheme is "App" unless configured.)
  scheme="$(json "$(xcodebuild -list -json -project "$xcodeproj")" project.targets.0)"
  build_dir="$(json "$cap" ios.nativeProjectDirAbs)/build"
}

case "${1:-}" in
  iphone)
    device="${2:-}"
    if [ -z "$device" ]; then
      echo "Missing device ID. Connected devices:" >&2
      npx cap run ios --list | grep -v simulator >&2
      exit 1
    fi
    web ios
    ios_setup
    xcodebuild "${container[@]}" -scheme "$scheme" -configuration Debug \
      -destination "id=$device" -derivedDataPath "$build_dir" \
      -allowProvisioningUpdates build
    apps=("$build_dir"/Build/Products/Debug-iphoneos/*.app)
    if [ ${#apps[@]} -ne 1 ]; then
      echo "Expected one .app in $build_dir/Build/Products/Debug-iphoneos" >&2
      exit 1
    fi
    bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "${apps[0]}/Info.plist")"
    xcrun devicectl device install app --device "$device" "${apps[0]}"
    xcrun devicectl device process launch --device "$device" "$bundle_id"
    ;;

  ios)
    web ios
    ios_setup
    # Every upload needs a higher build number; a timestamp always is, and
    # overriding it here leaves project.pbxproj untouched.
    build_number="$(date +%Y%m%d.%H%M)"
    archive="$build_dir/$scheme.xcarchive"
    options="$build_dir/ExportOptions.plist"
    rm -rf "$archive"
    mkdir -p "$build_dir"
    cat > "$options" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
    xcodebuild "${container[@]}" -scheme "$scheme" -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$archive" \
      -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$build_number" archive
    xcodebuild -exportArchive -archivePath "$archive" \
      -exportOptionsPlist "$options" -exportPath "$build_dir/export" \
      -allowProvisioningUpdates
    echo "Uploaded build $build_number; App Store Connect emails when it has been processed."
    ;;

  android)
    dest="${2:-}"
    [ -n "$dest" ] || usage
    web android
    cap="$(npx cap config --json)"
    if [ -z "${JAVA_HOME:-}" ]; then
      JAVA_HOME="$(/usr/libexec/java_home)"
      export JAVA_HOME
    fi
    (cd "$(json "$cap" android.platformDirAbs)" && ./gradlew assembleDebug)
    if [ -d "$dest" ]; then
      # "Fence-ter" → fence-ter-20261124.apk
      name="$(json "$cap" app.appName | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')"
      dest="$dest/$name-$(date +%Y%m%d).apk"
    fi
    cp "$(json "$cap" android.buildOutputDirAbs)/$(json "$cap" android.apkName)" "$dest"
    echo "APK copied to $dest"
    ;;

  *)
    usage
    ;;
esac
