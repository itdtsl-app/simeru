#!/bin/sh
# Menjalankan semua uji otomatis (butuh Node >= 22.6 dan Python 3)
set -e
cd "$(dirname "$0")/.."
node tests/lib.test.js
node tests/smoke.test.js
node --experimental-strip-types --no-warnings tests/feed.test.mjs
python3 tests/test_migrate.py
