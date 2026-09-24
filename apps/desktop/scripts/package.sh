#!/usr/bin/env bash
#
# Packages the desktop browser.
#
#   pnpm --filter @jasb/desktop dist              # this machine's platform
#   pnpm --filter @jasb/desktop dist -- --mac     # any electron-builder flags
#
# electron-builder cannot package straight out of a pnpm workspace: it refuses
# files that live outside the app directory, and @jasb/intent-engine is a
# symlink to ../../packages. So we stage a self-contained copy first with
# `pnpm deploy` (real files, production dependencies only) and package that.

set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$DESKTOP/../.." && pwd)"
STAGE="$DESKTOP/.stage"

# Git Bash on Windows hands out /d/a/… paths, which Node cannot open.
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

cd "$ROOT"
pnpm --filter @jasb/intent-engine build >/dev/null
pnpm --filter @jasb/desktop build >/dev/null

rm -rf "$STAGE"
pnpm --filter @jasb/desktop deploy --prod --legacy "$STAGE" >/dev/null

# Electron itself is a dev dependency, so the stage does not have it. Tell
# electron-builder which runtime to download instead.
ELECTRON_VERSION="$(node -p "require('$(native "$DESKTOP")/node_modules/electron/package.json').version")"

# Without an explicit certificate, don't let electron-builder pick whatever is
# in the keychain: an "Apple Development" identity signs the app but Gatekeeper
# still blocks it on other machines, which is worse than an honest unsigned build.
if [[ -z "${CSC_LINK:-}" && -z "${CSC_NAME:-}" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

cd "$STAGE"
"$DESKTOP/node_modules/.bin/electron-builder" \
  --config "$(native "$DESKTOP")/electron-builder.yml" \
  -c.electronVersion="$ELECTRON_VERSION" \
  -c.directories.output="$(native "$DESKTOP")/release" \
  -c.directories.buildResources="$(native "$DESKTOP")/build" \
  "$@"

rm -rf "$STAGE"
ls -1 "$DESKTOP/release" | grep -E '\.(dmg|zip|exe|AppImage|deb)$' || true
