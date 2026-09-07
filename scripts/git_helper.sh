#!/bin/bash
# git_helper.sh — unified git/tag helper for swing-analysis
#
# Modeled on cc-mode-switcher's scripts/git_helper.sh, adapted to this
# repo's release topology:
#
#   swing-analysis (private, CI + source of truth)
#        │ set-version.yml   = the ONLY writer of (version commit, tag)
#        │ release.yml       = builds installers from an EXISTING tag,
#        │                     uploads them as a DRAFT release on…
#        ▼
#   swing-analysis-app (public mirror) — Releases live HERE, not here.
#
# Consequence: "tag 问题" in this repo is a TWO-repo problem. Re-releasing
# vN.N.N requires deleting BOTH the tag on origin (or set-version.yml will
# refuse: "Tag already exists") AND the release on the public mirror (or
# release.yml's `gh release create` will fail). Neither workflow ever
# deletes anything — cleanup is manual by design. That's what this helper
# automates, with per-step confirmation.
#
# Subcommands:
#   list-tags       local tags vs origin, + what release.yml would pick   [alias: lt]
#   list-releases   releases on the public mirror repo                    [alias: lr]
#   delete-tag      delete a tag locally and/or on origin
#   delete-release  delete a release (incl. draft) on the public mirror
#   re-release      guided cleanup + re-tag for republishing a version    [alias: rr]
#   set-tag         manual tag create + push (⚠ prefer set-version.yml!)
#   call-workflow   trigger a GitHub Actions workflow (gh CLI)            [alias: cw]
#   list-workflow   list GitHub Actions workflows (gh CLI)                [alias: lw]
#   reset           hard-reset current branch to a commit + force-push
#   help            show this help
#
# Run `git_helper.sh help` any time.

set -euo pipefail

SCRIPT_NAME=$(basename "$0")

# Releases live on the PUBLIC mirror, never on this repo. Override for
# forks/testing: SWING_PUBLIC_REPO=me/my-mirror ./scripts/git_helper.sh ...
PUBLIC_REPO="${SWING_PUBLIC_REPO:-acecrush-dev/swing-analysis-app}"

# -----------------------------------------------------------------------------
# help
# -----------------------------------------------------------------------------

usage() {
  cat <<EOF
$SCRIPT_NAME — unified git/tag helper for swing-analysis

Usage:
  $SCRIPT_NAME <command> [args]

Tag 状态查询:
  list-tags       本地 tag vs origin 对照 + package.json 当前版本
                  + 远程最高 semver tag（release.yml 留空 version 时选它）(alias: lt)
  list-releases   公开镜像仓库 $PUBLIC_REPO 上的 releases/drafts (alias: lr)

清理（重发同一版本前必做）:
  delete-tag      删除本地和/或 origin 上的 tag
                  $SCRIPT_NAME delete-tag <tag>            # 本地 + 远程
                  $SCRIPT_NAME delete-tag <tag> --local    # 仅本地
                  $SCRIPT_NAME delete-tag <tag> --remote   # 仅远程
  delete-release  删除镜像仓库上的 release（draft/public 均可）
                  $SCRIPT_NAME delete-release <tag>
  re-release      引导式重发：<删 origin tag> + <删镜像 release> + <触发
                  set-version.yml 重建 tag>，最后提示如何跑 release.yml (alias: rr)
                  $SCRIPT_NAME re-release 1.2.3            # 接受 1.2.3 或 v1.2.3

创建（⚠️ 规范路径是 workflow）:
  set-tag         手动打 tag 并推送（不会 bump package.json → 安装包版本号
                  会是旧的；正常发版请用 call-workflow set-version.yml）(alias: st)
                  $SCRIPT_NAME set-tag <tag> [commit] [--lightweight]
  call-workflow   触发 GitHub Actions workflow (alias: cw)
                  $SCRIPT_NAME call-workflow set-version.yml -f mode=set -f version=1.2.3
                  $SCRIPT_NAME call-workflow release.yml -f version=v1.2.3 -f publish_final=true
  list-workflow   列出远程 workflows (alias: lw)

通用:
  reset           硬回退当前分支到某 commit 并强推
                  $SCRIPT_NAME reset <commit>
  help            显示本帮助 (alias: --help, -h, 或无参数)

典型发版流程（详见 .github/workflows/ 头注释）:
  1. call-workflow set-version.yml -f mode=auto -f bump=patch   # bump + tag
  2. call-workflow release.yml                                  # 构建 → draft
  3. 验证 draft 后: call-workflow release.yml -f version=vN.N.N -f publish_final=true
重发失败版本时:  re-release <version>  （第 1-2 步的清理+重建一条龙）

gh CLI 需已安装且 gh auth login（call-workflow / list-* / delete-release 用）。
EOF
}

require_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "❌ Error: not inside a git working tree" >&2
    exit 1
  fi
}

# show_group <title> <multiline-content-or-empty> — uniform list section printer
show_group() {
  local title="$1" content="$2"
  echo ""
  echo "$title"
  if [[ -n "$content" ]]; then
    printf '  %s\n' "$content"
  else
    echo "  （无）"
  fi
}

confirm() {
  local prompt="$1"
  read -p "$prompt [y/N] " -r
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
  fi
}

# Accept "1.2.3" or "v1.2.3" → sets TAG / VER (mirrors release.yml's resolve logic)
normalize_version() {
  local raw="${1:-}"
  case "$raw" in
    v*) TAG="$raw"; VER="${raw#v}" ;;
    *)  TAG="v$raw"; VER="$raw" ;;
  esac
  if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ Error: '$raw' 不是合法 semver (期望 X.Y.Z 或 vX.Y.Z)" >&2
    exit 1
  fi
}

require_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "❌ Error: gh CLI 未安装" >&2
    echo "" >&2
    echo "安装:" >&2
    echo "  macOS:  brew install gh" >&2
    echo "  其他:    https://cli.github.com/manual/installation" >&2
    echo "" >&2
    echo "安装后请先认证:  gh auth login" >&2
    exit 127
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "❌ Error: gh CLI 未认证" >&2
    echo "请先运行:  gh auth login" >&2
    exit 1
  fi
}

# mirror_release_exists <tag> → 0 if a release (draft or public) exists on the mirror
mirror_release_exists() {
  gh release view "$1" --repo "$PUBLIC_REPO" >/dev/null 2>&1
}

# -----------------------------------------------------------------------------
# list-tags — local vs origin, + the two versions that matter
# -----------------------------------------------------------------------------

cmd_list_tags() {
  require_git_repo

  local local_tags remote_tags
  local_tags=$(git tag --list | sort -V)
  # Same filter release.yml uses: plain vX.Y.Z refs, no ^{} peeled entries.
  remote_tags=$(git ls-remote --tags origin \
                  | awk '{print $2}' \
                  | sed 's|^refs/tags/||' \
                  | grep -v '\^' \
                  | sort -V || true)

  local cur_version highest
  cur_version=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
  highest=$(printf '%s\n' "$remote_tags" \
              | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' \
              | sort -V | tail -n 1 || true)

  echo "======================================"
  echo "本地 tags:        $(printf '%s' "$local_tags" | grep -c . || true 0)"
  echo "origin tags:      $(printf '%s' "$remote_tags" | grep -c . || true 0)"
  echo "package.json:     $cur_version"
  echo "远程最高 semver:   ${highest:-（无）}  ← release.yml 留空 version 时构建它"
  echo "======================================"

  local only_local="" only_remote="" both=""
  if [[ -n "$local_tags" && -n "$remote_tags" ]]; then
    only_local=$(comm -23 <(printf '%s\n' "$local_tags") <(printf '%s\n' "$remote_tags") || true)
    only_remote=$(comm -13 <(printf '%s\n' "$local_tags") <(printf '%s\n' "$remote_tags") || true)
    both=$(comm -12 <(printf '%s\n' "$local_tags") <(printf '%s\n' "$remote_tags") || true)
  else
    only_local="$local_tags"
    only_remote="$remote_tags"
  fi

  show_group "仅本地（origin 上没有 → push 或 delete-tag <tag> --local）:" "$only_local"
  show_group "仅远程（本地没有 → git fetch --tags origin 或 delete-tag <tag> --remote）:" "$only_remote"
  show_group "本地+远程一致:" "$both"

  echo ""
  echo "提示: 镜像仓库上的 release/draft 用  $SCRIPT_NAME list-releases  查看"
}

# -----------------------------------------------------------------------------
# list-releases — releases/drafts on the public mirror
# -----------------------------------------------------------------------------

cmd_list_releases() {
  require_gh

  echo "======================================"
  echo "镜像仓库 releases: $PUBLIC_REPO"
  echo "======================================"
  if ! gh release list --repo "$PUBLIC_REPO"; then
    echo "⚠️  读取失败（无权限或仓库不存在）。" >&2
    echo "    需要本地 gh 账号能读 ${PUBLIC_REPO}（CI 侧用的是 PAT_PUBLIC_REPO" >&2
    echo "    secret；个人账号对公开仓库默认有读权限，报错请检查 gh auth login）。" >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# delete-tag — local / remote / both (port from cc-mode-switcher)
# -----------------------------------------------------------------------------

cmd_delete_tag() {
  require_git_repo

  if [[ $# -lt 1 ]]; then
    echo "用法: $SCRIPT_NAME delete-tag <tag> [--local|--remote]"
    echo "  默认同时删除本地 + 远程"
    exit 1
  fi

  local tag="$1"
  shift
  local do_local=true
  local do_remote=true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local)  do_local=true;  do_remote=false; shift ;;
      --remote) do_local=false; do_remote=true;  shift ;;
      *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
  done

  local scope=""
  $do_local  && scope+="本地 "
  $do_remote && scope+="origin "

  # Release tags in this repo are always v-prefixed (set-version.yml creates
  # vX.Y.Z). If a bare semver was given and the exact name exists nowhere but
  # the v-form is on origin, resolve to it — otherwise `delete-tag 1.0.0`
  # dies with a misleading "不存在或无权限" when the real cause is the
  # missing `v`.
  if [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    # ls-remote patterns are literal tail-matches: a trailing `$` there is an
    # ordinary character and matches nothing. Anchor on the grep side instead.
    if ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null 2>&1 \
       && git ls-remote --tags origin "refs/tags/v${tag}" | grep -q "refs/tags/v${tag}\$"; then
      echo "提示: 本地/origin 都没有 tag ${tag}，但 origin 有 v${tag}（本仓库发版 tag 均带 v 前缀）"
      echo "      → 按 v${tag} 处理"
      tag="v${tag}"
    fi
  fi

  echo "======================================"
  echo "删除tag: $tag"
  echo "范围: ${scope}"
  echo "⚠️  若镜像仓库还有同名 release，重发前还需: $SCRIPT_NAME delete-release $tag"
  echo "======================================"
  confirm "确认删除?"

  if $do_local; then
    if git tag -d "$tag" 2>/dev/null; then
      echo "✅ 本地 tag $tag 已删除"
    else
      echo "⚠️  本地不存在 tag $tag (跳过)"
    fi
  fi

  if $do_remote; then
    # Show git's raw stderr — "不存在" and "无权限" need different fixes,
    # so never collapse them into one message.
    local push_err
    if push_err=$(git push origin --delete "$tag" 2>&1); then
      echo "✅ origin tag $tag 已删除"
    else
      echo "⚠️  远程删除失败，git 原始报错:" >&2
      printf '    %s\n' "$push_err" >&2
      echo "    （多为 tag 不存在；若报 protected tag / denied 则是保护规则或权限）" >&2
    fi
  fi
}

# -----------------------------------------------------------------------------
# delete-release — remove a release (incl. draft) from the public mirror
# -----------------------------------------------------------------------------

cmd_delete_release() {
  require_gh

  if [[ $# -lt 1 ]]; then
    echo "用法: $SCRIPT_NAME delete-release <tag>"
    echo "  删除 $PUBLIC_REPO 上的 release（draft / public 均可）"
    exit 1
  fi

  normalize_version "$1"

  if ! mirror_release_exists "$TAG"; then
    echo "⚠️  镜像仓库 ${PUBLIC_REPO} 上不存在 release ${TAG}（或无权限），无需删除"
    exit 0
  fi

  local draft_state
  draft_state=$(gh release view "$TAG" --repo "$PUBLIC_REPO" --json isDraft -q '.isDraft' 2>/dev/null && true)
  local kind="public"
  [[ "$draft_state" == "true" ]] && kind="draft"

  echo "======================================"
  echo "删除镜像 release: $TAG"
  echo "仓库:   $PUBLIC_REPO"
  echo "状态:   $kind"
  echo "⚠️  这是发布物删除操作，public release 删了对外就没了"
  echo "======================================"
  confirm "确认删除?"

  # No --cleanup-tag on purpose: the mirror-side tag ref is cosmetic noise
  # (release.yml's `gh release create` happily reuses an existing tag ref),
  # and the flag adds failure modes (gh < 2.37, absent tag refs) that would
  # abort this script under set -e right after the release is already gone.
  if gh release delete "$TAG" --repo "$PUBLIC_REPO" --yes; then
    echo "✅ 镜像 release $TAG 已删除"
    echo "  （镜像侧可能残留同名 tag ref，无实际影响）"
  else
    echo "❌ 删除失败" >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# re-release — guided cleanup + re-tag for republishing a version
# -----------------------------------------------------------------------------

cmd_re_release() {
  require_git_repo
  require_gh

  if [[ $# -lt 1 ]]; then
    echo "用法: $SCRIPT_NAME re-release <version>    # 1.2.3 或 v1.2.3"
    echo ""
    echo "场景: 某版本构建/发布有问题，要重发同一版本号。"
    echo "为什么需要它: set-version.yml 拒绝已存在的 tag；release.yml 的"
    echo "gh release create 撞上已存在的 release 会失败。两边都必须先清。"
    exit 1
  fi

  normalize_version "$1"

  echo "======================================"
  echo "重发 $TAG 计划:"
  echo "  1. 删 origin tag $TAG        （私有仓库，set-version 才能重建）"
  echo "  2. 删镜像 release ${TAG}       （${PUBLIC_REPO}，release 才能重建）"
  echo "  3. 触发 set-version.yml mode=set version=$VER"
  echo "     → bump package.json、新 commit、重建并推送 tag"
  echo "  4.（手动）set-version 完成后触发 release.yml version=$TAG"
  echo "======================================"

  # ── 1. origin tag ──
  echo ""
  echo "── 1/3 origin tag ──"
  if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q "refs/tags/${TAG}\$"; then
    confirm "确认删除 origin 上的 $TAG?"
    git push origin --delete "$TAG"
    echo "✅ origin tag $TAG 已删除"
  else
    echo "⚠️  origin 上没有 ${TAG}（跳过）"
  fi
  if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
    confirm "本地也有 ${TAG}，一并删除?"
    git tag -d "$TAG"
  fi

  # ── 2. mirror release ──
  echo ""
  echo "── 2/3 镜像 release ──"
  if mirror_release_exists "$TAG"; then
    confirm "确认删除 $PUBLIC_REPO 上的 release $TAG?"
    gh release delete "$TAG" --repo "$PUBLIC_REPO" --yes
    echo "✅ 镜像 release $TAG 已删除"
  else
    echo "⚠️  镜像上没有 $TAG 的 release（跳过）"
  fi

  # ── 3. re-tag via workflow ──
  echo ""
  echo "── 3/3 重建 tag（set-version.yml）──"
  confirm "确认触发 set-version.yml (mode=set, version=$VER)?"
  gh workflow run set-version.yml -f mode=set -f version="$VER"
  echo "✅ 已触发。跟踪: gh run list --workflow=set-version.yml --limit 1"
  echo ""
  echo "──────────────────────────────────────"
  echo "后续（等 set-version 全绿后手动执行）:"
  echo "  $SCRIPT_NAME call-workflow release.yml -f version=$TAG"
  echo "  （draft 验证通过后再: -f version=$TAG -f publish_final=true）"
  echo "──────────────────────────────────────"
}

# -----------------------------------------------------------------------------
# set-tag — manual tag create + push (port from cc-mode-switcher, + warning)
# -----------------------------------------------------------------------------

cmd_set_tag() {
  require_git_repo

  if [[ $# -lt 1 ]]; then
    echo "用法: $SCRIPT_NAME set-tag <tag> [commit] [--lightweight]"
    echo "  默认: annotated tag at HEAD, message = 'Tag <tag> at <short-sha>'"
    exit 1
  fi

  local tag="$1"
  shift

  local lightweight=false
  local commit="HEAD"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --lightweight|-l) lightweight=true; shift ;;
      -*) echo "未知参数: $1" >&2; exit 1 ;;
      *)
        if [[ "$commit" == "HEAD" ]]; then
          commit="$1"
          shift
        else
          echo "多余的位置参数: $1" >&2
          exit 1
        fi
        ;;
    esac
  done

  local short_sha
  short_sha=$(git rev-parse --short "$commit" 2>/dev/null) || {
    echo "❌ Error: 无法解析 commit: $commit" >&2
    exit 1
  }

  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "❌ Error: tag $tag 已存在 (本地)。先删除: $SCRIPT_NAME delete-tag $tag" >&2
    exit 1
  fi
  if git ls-remote --tags origin "refs/tags/${tag}" | grep -q "refs/tags/${tag}\$"; then
    echo "❌ Error: tag $tag 已存在 (origin)。先删除: $SCRIPT_NAME delete-tag $tag --remote" >&2
    exit 1
  fi

  echo "======================================"
  echo "⚠️  本仓库规范发版路径是 set-version.yml（先 bump package.json 并提交，"
  echo "    再打 tag）。手动 set-tag 打出的 tag 不含版本号提交，release.yml 从"
  echo "    tag checkout 出的 package.json 版本号会是旧的 —— 安装包里版本错误。"
  echo "    正常发版: $SCRIPT_NAME call-workflow set-version.yml -f mode=set -f version=X.Y.Z"
  echo "======================================"
  echo "新建tag:    $tag"
  echo "指向commit: $commit ($short_sha)"
  echo "类型:       $($lightweight && echo "lightweight" || echo "annotated")"
  echo "将push到:   origin"
  echo "======================================"
  confirm "仍要手动创建并推送?"

  if $lightweight; then
    git tag "$tag" "$commit"
  else
    git tag -a "$tag" "$commit" -m "Tag $tag at $short_sha"
  fi

  git push origin "$tag"

  echo ""
  echo "✅完成。tag $tag 已创建并推送到 origin"
  echo "  验证: git ls-remote origin $tag"
}

# -----------------------------------------------------------------------------
# call-workflow — trigger a GitHub Actions workflow via gh CLI (port)
# -----------------------------------------------------------------------------

cmd_call_workflow() {
  if [[ $# -lt 1 ]]; then
    echo "用法: $SCRIPT_NAME call-workflow <workflow-file-or-id> [-f key=val ...]"
    echo "示例: $SCRIPT_NAME call-workflow set-version.yml -f mode=set -f version=1.2.3"
    echo "      $SCRIPT_NAME call-workflow release.yml -f version=v1.2.3 -f publish_final=true"
    exit 1
  fi

  require_gh

  local workflow="$1"
  shift
  local -a inputs=()
  local has_inputs=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--field) inputs+=(-f "$2"); has_inputs=true; shift 2 ;;
      *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
  done

  echo "======================================"
  echo "触发 workflow: $workflow （repo = origin）"
  if $has_inputs; then
    echo "inputs:"
    printf '  %s\n' "${inputs[@]}"
  fi
  echo "======================================"

  # `+ "${array[@]}"` form: no-op on empty array (avoids bash 3.2 + set -u
  # "unbound variable" on macOS).
  if $has_inputs; then
    gh workflow run "$workflow" ${inputs[@]+"${inputs[@]}"}
  else
    gh workflow run "$workflow"
  fi

  echo ""
  echo "✅ 已触发。查看 run:"
  echo "  gh run list --workflow=\"$workflow\" --limit 1"
  echo "  gh run watch \$(gh run list --workflow=\"$workflow\" --limit 1 --json databaseId -q '.[0].databaseId')"
}

# -----------------------------------------------------------------------------
# list-workflow — list remote GitHub Actions workflows (port)
# -----------------------------------------------------------------------------

cmd_list_workflow() {
  require_gh

  echo "======================================"
  echo "远程 workflows:"
  echo "======================================"
  gh workflow list
}

# -----------------------------------------------------------------------------
# reset — port of cc-mode-switcher's reset
# -----------------------------------------------------------------------------

cmd_reset() {
  require_git_repo

  local target_commit="${1:-}"

  if [[ -z "$target_commit" ]]; then
    echo "用法:"
    echo "  $SCRIPT_NAME reset <commit>"
    echo "  (for tag deletes use: $SCRIPT_NAME delete-tag <tag>)"
    exit 1
  fi

  local cur_branch
  cur_branch=$(git rev-parse --abbrev-ref HEAD)

  echo "======================================"
  echo "当前分支: $cur_branch"
  echo "回退目标commit: $target_commit"
  echo "======================================"
  echo "⚠️  警告：会丢弃当前分支之后所有提交，改写远程历史！"
  confirm "确认继续?"

  git reset --hard "$target_commit"
  git push origin "${cur_branch}" --force-with-lease

  echo ""
  echo "✅完成。当前HEAD："
  git log -1 --oneline
}

# -----------------------------------------------------------------------------
# entry point
# -----------------------------------------------------------------------------

cmd="${1:-help}"
case "$cmd" in
  list-tags|lt)         shift; cmd_list_tags "$@" ;;
  list-releases|lr)     shift; cmd_list_releases "$@" ;;
  delete-tag)           shift; cmd_delete_tag "$@" ;;
  delete-release)       shift; cmd_delete_release "$@" ;;
  re-release|rr)        shift; cmd_re_release "$@" ;;
  set-tag|st)           shift; cmd_set_tag "$@" ;;
  call-workflow|cw)     shift; cmd_call_workflow "$@" ;;
  list-workflow|lw)     shift; cmd_list_workflow "$@" ;;
  reset)                shift; cmd_reset "$@" ;;
  help|--help|-h|"")    usage ;;
  *) echo "未知命令: $cmd"; echo; usage; exit 1 ;;
esac
