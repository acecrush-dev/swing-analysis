#!/usr/bin/env bash
# deploy-vercel.sh — 部署 AceCrush Swing-Analysis 文档站（VitePress）到 Vercel
# 仿照 acecrush-craft/app/docs/scripts/deploy-vercel.sh 的纯 CLI 流程
#
# 发布目标：https://swing-analysis-docs.acecrush.dev
#   ⚠️  子域名不能含下划线 —— Vercel alias API 严格校验 RFC 1123 hostname
#   （只允许 [a-z0-9-]，不能用 _）。
# 文档源：VitePress（GitHub Pages 镜像用 base='/swing-analysis-app/'；本脚本部署到
# Vercel 时强制覆盖 base='/' 走根路径，不然 asset URL 带前缀 CSS 全废）
#
# 与 craft 版（acecrush-craft/app/docs/scripts/deploy-vercel.sh）的差异：
#   1. 本脚本位于 scripts/，PROJECT_ROOT 是上一级（项目根）—— docs 构建从根
#      package.json 跑（swing-analysis 的 docs/ 没有自己的 package.json）
#   2. build 产物在 docs/.vitepress/dist
#   3. .env 支持多文件按序合并加载（某个文件缺 CF 键时继续找下一个）：
#      swing-analysis/.env → ../acecrush-craft/app/docs/.env（CF 凭据实际所在）
#   4. 未 link 时自动 `vercel link --yes --project $DOCS_PROJECT`（craft 版是报错退出）
#   5. CF 凭据只在真正跑 DNS 步骤时要求（--skip-dns 时不需要）
#   6. 域名用 `domains add`（项目域）而非 craft 版的 `alias set`（单次部署 alias）——
#      后者流量可通但 Vercel 后台 Domains 列表不显示（2026-09-18 实测踩坑）
#
# 前置（一次性）：
#   1. Vercel 账号（https://vercel.com/signup，Hobby plan 即可）
#   2. Cloudflare 账号 + 域名 acecrush.dev（DNS 托管在 CF）
#   3. 本机装 vercel CLI：npm i -g vercel
#   4. vercel login（浏览器授权）— 脚本会自动检测登录态，未登录时自动触发
#
# 流程（与 craft docs 脚本几乎一致）：
#   1. CF DNS：swing-analysis-docs CNAME cname.vercel-dns.com（不动 apex A / www）
#   2. vercel login check
#   3. npm run docs:build -- --base / → docs/.vitepress/dist（**本地** build，Vercel 端不 build）
#   4. dist 复制到仓库外临时目录（剥离 git 元数据，避免 Vercel 拿 commit 邮箱去
#      GitHub 校验导致整单 BLOCKED）→ vercel deploy --prod --yes
#   5. 域名挂载：vercel domains add swing-analysis-docs.acecrush.dev（项目域模式，
#      后台 Domains 列表可见、自动跟随生产部署 —— 同 acecrush-website 的显示效果）；
#      domains add 失败时回退 alias set（流量可通但后台不显示，仅兜底）
#
# 关于 base path：当前 docs/.vitepress/config.mts 的 base='/swing-analysis-app/'，是为了
# GitHub Pages 镜像。本脚本部署到 Vercel 时默认强制覆盖为 base='/'（DOCS_BASE 默认 /），
# 所以文档实际 URL 是 https://swing-analysis-docs.acecrush.dev/
# GitHub Pages 镜像走自己的部署流程（scripts/deploy-docs.sh，gh-pages 分支），仍用
# config 的 base，不受本脚本的 DOCS_BASE 影响。
#
# 环境变量（只需 CF 两个；VERCEL_TOKEN 不需要 —— `vercel login` 已认证本机）：
#   CF_API_KEY      Cloudflare API Token（账号 → API Tokens → Create，权限 Zone:DNS:Edit）
#   CF_EMAIL        Cloudflare 账号邮箱
#   CF_ZONE         默认 acecrush.dev
#   DOCS_SUBDOMAIN  默认 swing-analysis-docs（DNS 名；**不能用下划线**，Vercel alias API 拒）
#   DOCS_BASE       默认 /（覆盖 VitePress config 的 base='/swing-analysis-app/'，
#                   让 Vercel 部署走根路径；GitHub Pages 镜像不受影响）
#   DOCS_PROJECT    默认 swing-analysis-docs（Vercel 项目名）
#
# 用法：
#   ./scripts/deploy-vercel.sh               # 完整部署（CF DNS + build + Vercel deploy + alias）
#   DRY_RUN=1 ./scripts/deploy-vercel.sh     # 只跑 CF DNS 那步（dry-run），build + deploy 仍会执行
#   ./scripts/deploy-vercel.sh --skip-dns    # 跳过 DNS 更新（已配置过的情况）

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# 自动加载 .env：按序合并 —— 某个文件存在就 source，直到 CF_API_KEY / CF_EMAIL
# 都拿到为止（与 craft 版"只加载第一个存在的文件"不同：swing-analysis/.env 存在但
# 没有 CF 键，得继续往下找，CF 凭据实际放在 acecrush-craft/app/docs/.env）
for candidate in \
    "$PROJECT_ROOT/.env" \
    "$PROJECT_ROOT/../acecrush-craft/app/docs/.env"; do
  if [ -f "$candidate" ] && { [ -z "${CF_API_KEY:-}" ] || [ -z "${CF_EMAIL:-}" ]; }; then
    echo "==> loading env from $candidate"
    set -a
    # shellcheck disable=SC1090
    . "$candidate"
    set +a
  fi
done

SKIP_DNS=0
if [ "${1:-}" = "--skip-dns" ]; then SKIP_DNS=1; fi

CF_ZONE="${CF_ZONE:-acecrush.dev}"
DRY_RUN="${DRY_RUN:-0}"
DOCS_SUBDOMAIN="${DOCS_SUBDOMAIN:-swing-analysis-docs}"
# 默认 base=/：让 Vercel 部署走根路径（asset URL 不带 /swing-analysis-app/ 前缀，CSS 不废）。
# GitHub Pages 镜像走 scripts/deploy-docs.sh 自己的流程，仍用 config 里的 base，不受影响。
DOCS_BASE="${DOCS_BASE:-/}"
DOCS_PROJECT="${DOCS_PROJECT:-swing-analysis-docs}"
# Vercel deploy 路径（本地 build 产物目录）—— 提到顶部避免 set -u + 重构时漏
VERCEL_DEPLOY_DIR="${VERCEL_DEPLOY_DIR:-docs/.vitepress/dist}"

if [ "$SKIP_DNS" -eq 0 ]; then
  : "${CF_API_KEY:?need CF_API_KEY (Cloudflare API Token)}"
  : "${CF_EMAIL:?need CF_EMAIL}"

  echo "==> [1/4] update Cloudflare DNS -> Vercel ($DOCS_SUBDOMAIN.$CF_ZONE)"

  ZONE_ID=$(curl -fsS \
    -H "Authorization: Bearer $CF_API_KEY" \
    "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE" \
    | python3 -c "import sys, json; print(json.load(sys.stdin)['result'][0]['id'])")

  update_record() {
    local TYPE="$1" NAME="$2" CONTENT="$3"
    local EXISTING=$(curl -fsS \
      -H "Authorization: Bearer $CF_API_KEY" \
      "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$NAME&type=$TYPE")
    local ID=$(echo "$EXISTING" | python3 -c "import sys, json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')")
    if [ -n "$ID" ]; then
      echo "  update $TYPE $NAME -> $CONTENT (id=$ID)"
      if [ "$DRY_RUN" = "1" ]; then return; fi
      curl -fsS -X PUT \
        -H "Authorization: Bearer $CF_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"content\":\"$CONTENT\",\"ttl\":1,\"proxied\":false}" \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$ID" >/dev/null
    else
      echo "  create $TYPE $NAME -> $CONTENT"
      if [ "$DRY_RUN" = "1" ]; then return; fi
      curl -fsS -X POST \
        -H "Authorization: Bearer $CF_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"content\":\"$CONTENT\",\"ttl\":1,\"proxied\":false}" \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" >/dev/null
    fi
  }

  # 只动子域名（swing-analysis-docs CNAME），apex A 和 www CNAME 由 website 脚本管
  update_record CNAME "$DOCS_SUBDOMAIN.$CF_ZONE" "cname.vercel-dns.com"
fi

echo "==> [2/4] vercel login check"
# 同 craft 脚本（修复"卡死"）：本机没装全局 vercel 时，`npx vercel whoami`
# 会先弹 "Ok to proceed? (y)" 安装确认 —— 该提问走 stderr，被 2>/dev/null 吞掉后
# 脚本就停在等你按 y 的地方，看起来像永远卡住。
# 处理：优先用全局 vercel；否则 npx --yes（自动确认，不再提问），且不吞 stderr。
if command -v vercel >/dev/null 2>&1; then
  VERCEL_BIN="vercel"
else
  echo "  未找到全局 vercel CLI → 改用 npx --yes vercel（首次自动下载，可能较慢）"
  echo "  建议先执行一次:  npm i -g vercel   （之后本脚本直接用全局命令，秒过）"
  VERCEL_BIN="npx --yes vercel"
fi
VERCEL_USER="$($VERCEL_BIN whoami || true)"
if [ -z "$VERCEL_USER" ]; then
  echo "  Vercel 未登录 → 运行 vercel login（浏览器授权）"
  $VERCEL_BIN login
else
  echo "  Vercel 已登录: $VERCEL_USER"
fi

echo "==> [3/4] build"
# 本地 build（smoke test）。DOCS_BASE 非空时透传给 vitepress build
# （覆盖 config.mts 里的 base='/swing-analysis-app/'；根路径部署用 DOCS_BASE=/）
if [ -n "$DOCS_BASE" ]; then
  echo "  build with --base $DOCS_BASE (override config)"
  npm run docs:build -- --base "$DOCS_BASE"
else
  echo "  build with config default base (DOCS_BASE 空)"
  npm run docs:build
fi

echo "==> [4/4] deploy to Vercel (CLI)"
# 走"本地 build → 上传静态产物"模式 —— 传 dist 路径给 Vercel，Vercel 直接把它
# 当静态目录上传，不在云端 build。
# set +e 包起来：alias/deploy 任一失败不让脚本死掉
set +e
START_DEPLOY=$(date +%s)

if [ ! -f ".vercel/project.json" ]; then
  echo "  .vercel/project.json 不存在 → 自动 link（--yes --project $DOCS_PROJECT）"
  $VERCEL_BIN link --yes --project "$DOCS_PROJECT"
  if [ ! -f ".vercel/project.json" ]; then
    echo "  ❌ 自动 link 失败 — 在项目根手动跑一次："
    echo "     npx vercel link --yes --project ${DOCS_PROJECT}"
    echo "     （--project flag 强制 link 到现有项目，并绕开 GitHub 连接）"
    set -e
    exit 1
  fi
fi
CURRENT_PROJECT="$(grep -o '"projectName":"[^"]*"' .vercel/project.json | head -1 | cut -d'"' -f4)"
CURRENT_PROJECT_ID="$(grep -o '"projectId":"[^"]*"' .vercel/project.json | head -1 | cut -d'"' -f4)"
echo "  using saved Vercel project config: $CURRENT_PROJECT (id=$CURRENT_PROJECT_ID)"

# 把 project.json 复制到 dist/.vercel/ 让 Vercel CLI 读到正确的 projectId
# （不复制会按目录名 "dist" 建孤儿项目）
mkdir -p "$VERCEL_DEPLOY_DIR/.vercel"
cp "$PROJECT_ROOT/.vercel/project.json" "$VERCEL_DEPLOY_DIR/.vercel/project.json"

# ⚠️ deploy 目录在 git 仓库内时，Vercel CLI 会向上探测 .git 并给部署附带 git 元数据
# （branch / commit SHA / author email）。项目在 Vercel 端连了 GitHub 时，Vercel 会拿
# 这个邮箱去 GitHub 账号校验 —— 邮箱没绑定 GitHub（如 leochan007@163.com）→ 整单被
# BLOCKED（"commit email ... could not be matched to a GitHub account"）。
# 处理：把产物（含 .vercel/project.json）复制到仓库外的临时目录，并在该目录内
# 执行 deploy —— cwd 与目标路径都不在任何 .git 之下，CLI 探测不到 git 仓库就
# 不发元数据，部署纯静态上传、与 git 完全解耦。
DEPLOY_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/swing-analysis-docs-deploy.XXXXXX")" || {
  echo "  ❌ mktemp 失败，无法隔离 git 元数据"; exit 1; }
trap 'rm -rf "$DEPLOY_RUN_DIR"' EXIT
cp -R "$VERCEL_DEPLOY_DIR/." "$DEPLOY_RUN_DIR/"
# ⚠️ `vercel link` 自动创建新项目时，Framework Preset 会被探测成 Vite（仓库根的
# electron.vite.config.ts / vitepress 命中探测）→ 平台对上传的静态 dist 跑
# `vite build` → "vite: command not found" → 部署 Error（2026-09-18 实测踩坑）。
# 处理：在部署目录注入 vercel.json 把 framework 钉成 null —— 部署级配置覆盖项目
# 预设，云端零 build、纯静态托管。只写进临时目录，不污染仓库 / gh-pages 产物
# （同 craft docs/vercel.json 的 framework:null 思路）。
printf '%s\n' '{"$schema":"https://openapi.vercel.sh/vercel.json","framework":null}' \
  > "$DEPLOY_RUN_DIR/vercel.json"
DEPLOY_OUTPUT="$(cd "$DEPLOY_RUN_DIR" && $VERCEL_BIN deploy --prod --yes . 2>&1)"
echo "$DEPLOY_OUTPUT"
echo "  ---> [4/4] deploy 总耗时 $(($(date +%s) - START_DEPLOY))s"

# 域名挂载 —— 与 acecrush-website 同款「项目域（project domain）」模式：
#   website 后台能显示 acecrush.dev / www.acecrush.dev，是因为它们是项目的 Domain
#   （dashboard → Settings → Domains 列表），每次生产部署自动挂载、从不需要 alias。
#   旧 `alias set` 只生成绑定单次部署 URL 的 alias —— 流量通（域名能访问），
#   但后台项目 Domains 列表不显示（2026-09-18 实测踩坑）。
# 优先 `domains add <domain> <project>`（DNS CNAME 已配好时即时验证通过）；
# 重跑时报 "already attached / exists" 类错误属幂等正常；失败再退回 alias set 兜底。
DOMAIN="$DOCS_SUBDOMAIN.$CF_ZONE"
if $VERCEL_BIN domains add "$DOMAIN" "$CURRENT_PROJECT"; then
  echo "  ✓ $DOMAIN 已挂为项目域（dashboard → Settings → Domains 可见，自动跟随生产部署）"
else
  echo "  ⚠️  domains add 未成功（已挂过时报错属正常）→ 回退 alias set 兜底"
  # 直接抓输出里的 *.vercel.app 域名（比匹配 "Production" 行更稳，不受排版/耗时列影响）
  PROD_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -1)"
  if [ -z "$PROD_URL" ]; then
    echo "  ⚠️  deploy 输出里没抓到 Production URL，尝试从 vercel ls 取最新部署 URL"
    PROD_URL="$($VERCEL_BIN ls --prod 2>/dev/null | grep -E "$CURRENT_PROJECT_ID" | head -1 | awk '{print $NF}')"
  fi
  if [ -n "$PROD_URL" ]; then
    echo "==> aliasing $PROD_URL -> $DOMAIN"
    $VERCEL_BIN alias set "$PROD_URL" "$DOMAIN" \
      || echo "  ⚠️  alias 也失败 — 到 Vercel dashboard → Settings → Domains 手动添加 $DOMAIN"
  else
    echo "==> ⚠️  抓不到 production URL — 到 Vercel dashboard → Settings → Domains 手动添加 $DOMAIN"
  fi
fi
set -e

if [ "$DOCS_BASE" = "/" ]; then
  echo "==> done. Visit https://$DOMAIN (DNS + SSL 生效需 1-5 分钟)"
else
  echo "==> done. Visit https://$DOMAIN$DOCS_BASE (DNS + SSL 生效需 1-5 分钟)"
fi
