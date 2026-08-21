#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the DSH Desktop workspace.
# Prepares a compliant Node toolchain, the pinned upstream submodule, and the
# root Yarn dependency tree so `corepack yarn dev|build|test|check` all work.
# Graphical `yarn start` / `yarn dev` stay explicit and are not launched here.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

NODE_MAJOR="22"
YARN_VERSION="4.18.0"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

# DSH Desktop requires Node ^22.19.0 || >=24. The default Cloud Agent image
# ships an older Node on PATH (/exec-daemon/node), so select a compliant
# release through nvm and put it first for this process.
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR" >/dev/null
nvm alias default "$NODE_MAJOR" >/dev/null
nvm use "$NODE_MAJOR" >/dev/null
export PATH="${NVM_BIN:-$(dirname "$(command -v node)")}:$PATH"

corepack enable >/dev/null 2>&1 || true
corepack prepare "yarn@${YARN_VERSION}" --activate >/dev/null

echo "node $(node -v) / yarn $(corepack yarn --version)"

# Pinned upstream DeepSeek Harness checkout.
git submodule update --init --recursive

# The Cloud Agent checkout injects an access-token `insteadOf` rewrite for
# github.com. That rewrite makes `git remote get-url` inside the submodule
# report a tokenized URL, which trips scripts/verify-layout.mjs. Restore the
# canonical origin and add a longest-match identity override so get-url returns
# the upstream URL, while token auth still applies to every other github.com URL.
UPSTREAM_URL="$(git config -f .gitmodules --get submodule.deepseek-harness.url)"
git -C deepseek-harness remote set-url origin "$UPSTREAM_URL"
git -C deepseek-harness config --local "url.${UPSTREAM_URL}.insteadOf" "$UPSTREAM_URL"

# Root Yarn workspace (node-modules linker). The upstream submodule keeps its
# own pnpm workspace and is only installed on demand via `yarn upstream:*`.
corepack yarn install --immutable
