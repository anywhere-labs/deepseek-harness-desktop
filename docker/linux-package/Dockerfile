# Reproducible Linux packaging environment for DSH Desktop.
#
# Debian 12 (bookworm) carries glibc 2.36, comfortably above the 2.28 floor
# implied by the fpm and AppImage toolsets electron-builder downloads at build
# time. Keep NODE_VERSION equal to .github/workflows/ci.yml's node-version;
# tests/package.spec.ts asserts they match.
ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-bookworm

# rpmbuild ships in the `rpm` package and is a hard host requirement of the rpm
# target: electron-builder runs its own bundled fpm, and fpm shells out to
# `rpmbuild -bb`. A container does NOT inherit the GitHub runner image's
# preinstalled rpm, so it must be installed here.
#
# binutils supplies `ar` and xz-utils supplies `xz`; fpm uses both to assemble
# the deb. build-essential and python3 are needed by `yarn install`, because the
# root manifest marks node-pty, koffi, esbuild, electron, and
# @deepseek-ai/dsh-subprocess-local as built: true. Packaging itself passes
# --config.npmRebuild=false and rebuilds nothing.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    binutils \
    build-essential \
    ca-certificates \
    git \
    python3 \
    rpm \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# corepack enable writes pnpm/pnpx shims into /usr/local/bin, which the node
# base image leaves root-owned. Run it once here, as root, so the non-root
# build user below does not need write access to /usr/local/bin; the same
# `corepack enable` in the compose package service's command then finds the
# shims already in place and is a no-op.
RUN corepack enable

# Match the host account so the mounted repository never receives root-owned
# files. The node base image already defines uid/gid 1000, so reuse an existing
# id rather than failing on a duplicate. /cache and /home/builder are created
# and chowned here because Docker gives a freshly created named volume the
# ownership of the image directory it is mounted over.
ARG UID=1000
ARG GID=1000
RUN if ! getent group "${GID}" >/dev/null; then groupadd -g "${GID}" builder; fi \
  && if ! getent passwd "${UID}" >/dev/null; then useradd -m -u "${UID}" -g "${GID}" builder; fi \
  && mkdir -p /cache/yarn /cache/electron-builder /home/builder \
  && chown -R "${UID}:${GID}" /cache /home/builder

USER ${UID}:${GID}
WORKDIR /repo
