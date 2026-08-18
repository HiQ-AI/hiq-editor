#!/usr/bin/env sh
# hiq-editor installer — macOS / Linux
#
#   curl -fsSL https://raw.githubusercontent.com/HiQ-AI/hiq-editor/main/scripts/install.sh | sh
#
# Env:
#   HIQ_EDITOR_VERSION   version to install (default: latest release)
#   HIQ_EDITOR_INSTALL   install directory  (default: ~/.local/bin)
#   HIQ_EDITOR_BASE_URL  download origin    (default: GitHub Releases; set this to a mirror)
#
# Deliberately POSIX sh: this gets piped into whatever /bin/sh the box has.
set -eu

REPO=HiQ-AI/hiq-editor
INSTALL_DIR="${HIQ_EDITOR_INSTALL:-$HOME/.local/bin}"

# Default download origin. scripts/mirror-to-cdn.sh rewrites this one line in
# the copy it serves from download.hiq.earth, so users behind the GFW get a
# reachable origin without a second copy of this script to keep in sync.
DEFAULT_BASE="https://github.com/$REPO/releases/latest/download"

die() { printf '错误: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v tar  >/dev/null 2>&1 || die "需要 tar"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "不支持的系统: $(uname -s)。Windows 请用 scripts/install.ps1" ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "不支持的架构: $(uname -m)" ;;
esac

# No version lookup: GitHub resolves `releases/latest/download/<asset>` itself,
# which keeps a first install off the anonymous API and its 60-req/hour limit.
version="${HIQ_EDITOR_VERSION:-}"
if [ -n "${HIQ_EDITOR_BASE_URL:-}" ]; then
  base="$HIQ_EDITOR_BASE_URL"
elif [ -n "$version" ]; then
  base="https://github.com/$REPO/releases/download/v${version#v}"
else
  base="$DEFAULT_BASE"
fi

archive="hiq-editor-$os-$arch.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

info "下载 hiq-editor ${version:-latest} ($os-$arch)…"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || die "下载失败: $base/$archive"

# Checksums are advisory: verify when the file and a hashing tool are both
# available, never block the install because the box lacks shasum.
if curl -fsSL "$base/checksums.txt" -o "$tmp/sums.txt" 2>/dev/null; then
  if command -v shasum >/dev/null 2>&1; then sha=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
  elif command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
  else sha=""; fi
  if [ -n "$sha" ]; then
    grep -q "$sha" "$tmp/sums.txt" || die "校验和不匹配,已中止安装"
    info "校验和 OK"
  fi
fi

tar xzf "$tmp/$archive" -C "$tmp" || die "解压失败"
mkdir -p "$INSTALL_DIR"
mv "$tmp/hiq-editor" "$INSTALL_DIR/hiq-editor"
chmod +x "$INSTALL_DIR/hiq-editor"

# Downloads via curl carry no quarantine flag, but a binary that took a detour
# through a browser or an archiver does — clear it so Gatekeeper stays quiet.
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$INSTALL_DIR/hiq-editor" 2>/dev/null || true

info ""
info "已安装: $INSTALL_DIR/hiq-editor"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) info "下一步: hiq-editor login" ;;
  *)
    info ""
    info "$INSTALL_DIR 不在 PATH 里,把这行加进 ~/.zshrc 或 ~/.bashrc:"
    info "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
