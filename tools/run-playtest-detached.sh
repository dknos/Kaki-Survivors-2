#!/bin/bash
# Detached launcher for playtest-diag.mjs (survives the caller's timeout).
cd ~/kitty-kaki-survivors || exit 1
cp -f tools/playtest-diag-out.json tools/playtest-diag-out.run1.json 2>/dev/null
rm -f tools/playtest-diag-out.json
nohup /usr/bin/node tools/playtest-diag.mjs > tools/playtest-diag-run2.log 2>&1 &
echo "launched pid $!"
