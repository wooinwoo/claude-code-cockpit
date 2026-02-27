#!/bin/bash
# Extract all imported function names from a file
get_imports() {
  file=$1
  grep "^import" "$file" | sed 's/.*{//;s/}.*//' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$'
}

# Get all function definitions from a file
get_definitions() {
  file=$1
  grep -E "^(export )?(async )?function [a-zA-Z_$][a-zA-Z0-9_$]*|^(export )?const [a-zA-Z_$][a-zA-Z0-9_$]* =" "$file" | sed 's/.*function //;s/.*const //;s/[( =].*//' | grep -v '^$'
}

# Get all bare function calls (not method calls, not constructors)
get_bare_calls() {
  file=$1
  grep -oE '\b[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(' "$file" | sed 's/\s*($//' | sort -u
}

for file in dashboard.js modals.js terminal.js diff.js agent.js jira.js cicd.js notes.js workflows.js forge.js logs.js monitor.js; do
  echo "=== $file ==="
  echo "Imports:"
  get_imports "$file"
  echo ""
  echo "Local Definitions:"
  get_definitions "$file" | head -20
  echo ""
  echo "Bare Function Calls (first 30):"
  get_bare_calls "$file" | head -30
  echo ""
done
