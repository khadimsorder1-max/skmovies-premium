#!/usr/bin/env bash
#
# SKMovies এক-ক্লিক ডিপ্লয় স্ক্রিপ্ট (Cloudflare Pages)
#
# Usage:
#   ./deploy.sh                      # interactive
#   ./deploy.sh my-project-name      # project name pass করুন
#   PROJECT_NAME=foo ./deploy.sh     # env var
#
set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*" >&2; }
info() { echo -e "${BLUE}[i]${NC} $*"; }

# Detect script dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PROJECT_NAME="${1:-${PROJECT_NAME:-skmovies-premium}}"

log "SKMovies Deploy Script শুরু হলো"
info "Project name: $PROJECT_NAME"
echo ""

# 1. Node check
log "Node.js চেক করা হচ্ছে..."
if ! command -v node &>/dev/null; then
  err "Node.js install করা নেই। https://nodejs.org থেকে install করুন।"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js 18+ দরকার। বর্তমান: $(node --version)"
  exit 1
fi
info "Node $(node --version) ✓"

# 2. Wrangler check / install
log "Wrangler চেক করা হচ্ছে..."
if ! command -v wrangler &>/dev/null; then
  warn "Wrangler নেই। Global install করা হচ্ছে..."
  npm install -g wrangler
fi
info "Wrangler $(wrangler --version 2>&1 | head -1) ✓"

# 3. Prepare backend dir
log "Frontend assets backend-এ copy করা হচ্ছে..."
cd backend
cp -r ../frontend/* .

if [ ! -f index.html ]; then
  err "index.html পাওয়া যায়নি! frontend/ ফোল্ডার ঠিক আছে কিনা চেক করুন।"
  exit 1
fi
info "Frontend assets copied ✓"

# 4. Cloudflare login check
log "Cloudflare auth চেক করা হচ্ছে..."
if ! wrangler whoami &>/dev/null; then
  warn "Cloudflare তে logged in নন। লগইন prompt খুলছে..."
  wrangler login
fi
info "Logged in ✓"

# 5. Project create (যদি না থাকে)
log "Pages project চেক করা হচ্ছে..."
if ! wrangler pages project list 2>/dev/null | grep -q "^$PROJECT_NAME\b"; then
  warn "Project '$PROJECT_NAME' নেই। তৈরি করা হচ্ছে..."
  wrangler pages project create "$PROJECT_NAME" --production-branch=main || {
    err "Project create ব্যর্থ। এই নাম দিয়ে আগে থেকেই প্রজেক্ট থাকতে পারে।"
    exit 1
  }
fi
info "Project ready ✓"

# 6. Deploy
log "ডিপ্লয় করা হচ্ছে (এতে ১-২ মিনিট লাগতে পারে)..."
DEPLOY_OUTPUT=$(wrangler pages deploy . --project-name="$PROJECT_NAME" 2>&1) || {
  err "ডিপ্লয় ব্যর্থ:"
  echo "$DEPLOY_OUTPUT"
  exit 1
}

# 7. Extract URL
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9-]+\.pages\.dev' | head -1)

echo ""
echo "=================================================="
log "✅ ডিপ্লয় সফল!"
echo "=================================================="
echo ""
info "🌐 আপনার সাইট: $DEPLOY_URL"
info "📊 API test:    ${DEPLOY_URL}/api/latest?page=1"
info "🎨 Frontend:    ${DEPLOY_URL}/"
echo ""
warn "HDHub4u endpoint কাজ করবে না — Deno proxy ডিপ্লয় করতে হবে।"
warn "বিস্তারিত: HDHUB4U-WORKERS-403-FIX.md পড়ুন।"
echo ""
log "Done. ধন্যবাদ!"
