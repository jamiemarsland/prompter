#!/bin/sh
# Copies only the publishable files into dist/ (keeps .prompter-key out; keeps dist/.spacefast link).
set -e
cd "$(dirname "$0")"
mkdir -p dist
find dist -mindepth 1 -maxdepth 1 ! -name .spacefast -exec rm -rf {} +
cp index.html dist/
cp -R app dist/
cp -R functions dist/
