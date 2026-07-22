#!/usr/bin/env bash
#
# SKMovies Local Dev Server
#
# Usage:
#   ./dev.sh                # পুরো stack (frontend + backend)
#   ./dev.sh frontend       # শুধু frontend (API কাজ করবে না)
#   ./dev.sh backend        # শুধু backend (Wrangler pages dev)
#
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*" >&2; }
info() { echo -e "${BLUE}[i]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-full}"

case "$MODE" in
  full)
    log "Full stack dev server শুরু হচ্ছে..."
    cd backend
    cp -rf ../frontend/* . 2>/dev/null || true
    
    if ! command -v npx &>/dev/null; then
      err "Node/npx install করা নেই।"
      exit 1
    fi
    
    info "Wrangler install করা হচ্ছে (যদি দরকার হয়)..."
    npm install --silent 2>/dev/null || true
    
    info "Dev server শুরু হচ্ছে: http://localhost:8788/"
    info "API test: http://localhost:8788/api/latest?page=1"
    info "Stop করতে Ctrl+C চাপুন"
    echo ""
    npx wrangler pages dev . --port 8788
    ;;
    
  frontend)
    log "Frontend-only dev server..."
    cd frontend
    
    PORT=8080
    info "Server শুরু হচ্ছে: http://localhost:$PORT/"
    warn "API কল ব্যর্থ হবে (backend চলছে না)।"
    echo ""
    
    if command -v python3 &>/dev/null; then
      python3 -m http.server $PORT
    elif command -v npx &>/dev/null; then
      npx serve -l $PORT
    else
      err "python3 বা npx দরকার।"
      exit 1
    fi
    ;;
    
  backend)
    log "Backend-only dev server..."
    cd backend
    cp -rf ../frontend/* . 2>/dev/null || true
    info "Server শুরু হচ্ছে: http://localhost:8788/"
    npx wrangler pages dev . --port 8788
    ;;
    
  *)
    err "Invalid mode. Use: full | frontend | backend"
    echo ""
    echo "Usage:"
    echo "  $0            # full stack (default)"
    echo "  $0 frontend   # frontend only"
    echo "  $0 backend    # backend only"
    exit 1
    ;;
esac
