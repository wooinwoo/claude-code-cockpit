#!/usr/bin/env python3
import re
import sys

# List of known Window globals that were removed
WINDOW_GLOBALS = {
    'openTermWith', 'closeConvList', 'jumpToChanges', 'editProject', 'togglePin',
    'resumeLastSession', 'toggleDevServer', 'promptDevCmd', 'openIDE', 'openGitHub',
    'showSessionHistory', 'showGitLog', 'updateScrollIndicators',
    'renderCard', 'renderAllCards', 'showConvList', 'toggleTheme',
    'setProjectFilter', 'setProjectTag', 'fetchAllProjects', 'pullAllProjects',
    'updateSummaryStats', 'renderLayout', 'updateTermHeaders', 'debouncedUpdateTermHeaders',
    'openNewTermModal', 'exportTerminal', 'loadBranchesForTerm', 'updateTermTheme',
    'loadDiff', 'debouncedLoadDiff', 'renderProjectChips', 'populateProjectSelects',
    'updateDevBadge', 'renderNotifFilterList', 'openFilePreview', 'openFilePreviewFromFile',
    'toggleAgentPanel', 'handleAgentEvent', 'handleForgeEvent', 'handleWorkflowEvent',
    'initJira', 'initCicd', 'initNotes', 'initWorkflows', 'initForge', 'initLogs', 'initMonitor'
}

def get_imports(content):
    """Extract imported function names"""
    imports = set()
    for match in re.finditer(r'^import\s*{([^}]+)}', content, re.MULTILINE):
        names = match.group(1).split(',')
        for name in names:
            imports.add(name.strip())
    return imports

def get_local_defs(content):
    """Extract locally defined functions"""
    defs = set()
    # export function foo()
    for match in re.finditer(r'^export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)', content, re.MULTILINE):
        defs.add(match.group(1))
    # export const foo = () => {}
    for match in re.finditer(r'^export\s+const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=', content, re.MULTILINE):
        defs.add(match.group(1))
    # function foo()
    for match in re.finditer(r'^function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)', content, re.MULTILINE):
        defs.add(match.group(1))
    # const foo = () => {}
    for match in re.finditer(r'^const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=', content, re.MULTILINE):
        defs.add(match.group(1))
    return defs

def find_function_calls(content):
    """Find bare function calls (lines with functionName(...))"""
    # Pattern: word characters followed by (
    # But NOT preceded by . or = or : (to exclude method calls, assignments, object keys)
    calls = {}
    for match in re.finditer(r'(?<![.\w=:])\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(', content):
        fname = match.group(1)
        if fname not in calls:
            calls[fname] = []
        # Find line number
        line_num = content[:match.start()].count('\n') + 1
        calls[fname].append(line_num)
    return calls

files = ['dashboard.js', 'modals.js', 'terminal.js', 'diff.js', 'agent.js', 'jira.js', 
         'cicd.js', 'notes.js', 'workflows.js', 'forge.js', 'logs.js', 'monitor.js']

for fname in files:
    try:
        with open(fname, 'r', encoding='utf-8') as f:
            content = f.read()
        
        imports = get_imports(content)
        defs = get_local_defs(content)
        calls = find_function_calls(content)
        
        # Find calls that are neither imported nor defined locally
        problematic = {}
        for call_name, line_nums in sorted(calls.items()):
            if call_name in imports or call_name in defs:
                continue
            # Only report if it looks like a real function call (not method call context)
            # Check if it's in WINDOW_GLOBALS or looks suspicious
            if call_name in WINDOW_GLOBALS:
                problematic[call_name] = line_nums
        
        if problematic:
            print(f"\n{'='*60}")
            print(f"FILE: {fname}")
            print(f"{'='*60}")
            print(f"Imports ({len(imports)}): {', '.join(sorted(imports)[:5])}...")
            print(f"Local Defs ({len(defs)}): {', '.join(sorted(list(defs)[:5]))}...")
            print(f"\nProblematic calls (called but not imported or defined):")
            for call_name in sorted(problematic.keys()):
                lines = problematic[call_name]
                print(f"  - {call_name}() at lines: {lines[:3]}")
    except Exception as e:
        print(f"Error processing {fname}: {e}")
