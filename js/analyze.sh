#!/bin/bash

# For dashboard.js, check if these functions are called but not imported/defined locally
echo "=== DASHBOARD.JS ISSUES ==="
file="dashboard.js"

# Functions called in this file that need to be from other modules
needed_from_other_modules="editProject openTermWith resumeLastSession toggleDevServer promptDevCmd openIDE openGitHub showSessionHistory showGitLog closeConvList"

for func in $needed_from_other_modules; do
  # Check if it's imported
  if grep -q "^import.*$func" "$file"; then
    echo "$func: ✓ imported"
  # Check if it's locally defined
  elif grep -q "^export.*function $func\|^function $func\|^export.*const $func\|^const $func" "$file"; then
    echo "$func: ✓ locally defined"
  # Check if it's called
  elif grep -q "\b$func(" "$file"; then
    echo "$func: ✗ CALLED BUT NOT IMPORTED OR DEFINED - WILL FAIL"
  else
    echo "$func: not called"
  fi
done

echo ""
echo "=== TERMINAL.JS ISSUES ==="
file="terminal.js"
needed_from_other_modules="openNewTermModalWithSplit"

for func in $needed_from_other_modules; do
  if grep -q "^import.*$func" "$file"; then
    echo "$func: ✓ imported"
  elif grep -q "^export.*function $func\|^function $func" "$file"; then
    echo "$func: ✓ locally defined"
  elif grep -q "\b$func(" "$file"; then
    echo "$func: ✗ CALLED BUT NOT IMPORTED OR DEFINED - WILL FAIL"
  else
    echo "$func: not called"
  fi
done

