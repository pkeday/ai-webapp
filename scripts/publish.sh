#!/usr/bin/env bash
set -euo pipefail

MESSAGE="${*:-Update web app}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This folder is not a git repo yet."
  echo "Run: git init"
  exit 1
fi

git add .

if git diff --cached --quiet; then
  echo "No file changes to commit."
  exit 0
fi

git commit -m "$MESSAGE"
git push

echo "Pushed. GitHub Pages will redeploy automatically."
