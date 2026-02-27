#!/bin/bash

# For each file, check for potentially problematic function calls
files="dashboard.js modals.js terminal.js diff.js agent.js jira.js cicd.js notes.js workflows.js forge.js logs.js monitor.js"

# List of known functions that were removed from window object in main.js
# (based on the reported 200 functions removed)
# We'll check for these specific ones mentioned and look for other common patterns

check_file() {
  file=$1
  echo "=== $file ==="
  
  # Get imports from this file
  imports=$(grep "^import" "$file" | sed 's/.*{//;s/}.*//' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | tr '\n' '|' | sed 's/|$//')
  
  # Get local definitions
  defs=$(grep -E "^(export )?(async )?function [a-zA-Z_$]|^(export )?const [a-zA-Z_$].*=" "$file" | sed 's/.*function //;s/.*const //;s/[( =].*//' | tr '\n' '|' | sed 's/|$//')
  
  # Find function calls that look suspicious (not method calls, not constructors)
  # Common patterns: functionName() but NOT obj.functionName() or new Something()
  grep -oE '\b[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(' "$file" | sed 's/\s*($//' | sort -u | while read func; do
    # Skip if it's a builtin
    if [[ "$func" =~ ^(fetch|setInterval|setTimeout|clearInterval|clearTimeout|parseInt|parseFloat|isNaN|Number|String|Array|Object|Date|Math|console|document|window|localStorage|navigator|location|JSON|Promise|Map|Set|WeakMap|WeakSet|Symbol|Reflect|Proxy|Error|TypeError|RangeError|SyntaxError|requestAnimationFrame|cancelAnimationFrame|addEventListener|removeEventListener)$ ]]; then
      continue
    fi
    
    # Check if imported
    if [[ "$imports" =~ $func ]]; then
      continue
    fi
    
    # Check if locally defined
    if [[ "$defs" =~ $func ]]; then
      continue
    fi
    
    # Check if it's called in the file
    if grep -q "\b$func(" "$file"; then
      echo "  WARNING: $func() called but not imported or locally defined"
    fi
  done
}

for file in $files; do
  check_file "$file"
done
