// ─── Syntax Highlighting for Diff View ───
// Lightweight regex-based tokenizer. No external dependencies.

const E = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = s => s.replace(/[&<>"]/g, c => E[c]);

const EXT = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyw: 'py',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  json: 'json', jsonc: 'json',
  rs: 'rs', go: 'go', java: 'java', kt: 'java',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c',
  rb: 'rb', rake: 'rb',
  md: 'md', mdx: 'md',
  toml: 'toml',
};

export function getLangFromPath(path) {
  if (!path) return '';
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT[ext] || '';
}

// Rules: [tokenType, regexSource]
// Order matters — first match wins at each position.
// Token types: comment, string, keyword, number, type, tag, attr
const R = {
  js: [
    ['comment', '\\/\\/.*'],
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['string', '`(?:[^`\\\\]|\\\\.)*`'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|new|delete|typeof|instanceof|void|in|of|class|extends|super|import|export|default|from|as|async|await|yield|static|get|set|this)\\b'],
    ['number', '\\b(?:true|false|null|undefined|NaN|Infinity)\\b'],
    ['type', '\\b(?:Array|Object|String|Number|Boolean|Promise|Map|Set|RegExp|Date|Error|Symbol|BigInt|console|window|document|Math|JSON|parseInt|parseFloat|setTimeout|setInterval|clearTimeout|clearInterval|fetch|require)\\b'],
    ['number', '\\b(?:0[xX][\\da-fA-F]+|0[oO][0-7]+|0[bB][01]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)\\b'],
  ],
  py: [
    ['comment', '#.*'],
    ['string', '"""[\\s\\S]*?"""'],
    ['string', "'''[\\s\\S]*?'''"],
    ['string', 'f"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "f'(?:[^'\\\\]|\\\\.)*'"],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '\\b(?:def|class|if|elif|else|for|while|with|as|import|from|return|yield|try|except|finally|raise|pass|break|continue|and|or|not|is|in|lambda|global|nonlocal|assert|del|async|await)\\b'],
    ['number', '\\b(?:True|False|None)\\b'],
    ['type', '\\b(?:int|float|str|bool|list|dict|tuple|set|type|range|print|len|super|self|cls|__\\w+__)\\b'],
    ['number', '\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b'],
  ],
  css: [
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '@[\\w-]+'],
    ['keyword', '!important'],
    ['number', '#[\\da-fA-F]{3,8}\\b'],
    ['attr', '[\\w-]+(?=\\s*:)'],
    ['number', '\\b\\d+\\.?\\d*(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\\b'],
  ],
  html: [
    ['comment', '<!--[\\s\\S]*?-->'],
    ['string', '"[^"]*"'],
    ['string', "'[^']*'"],
    ['tag', '<\\/?[\\w-]+'],
    ['tag', '\\/?>'],
    ['attr', '[\\w-]+(?=\\s*=)'],
  ],
  json: [
    ['attr', '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['number', '\\b(?:true|false|null)\\b'],
    ['number', '-?\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b'],
  ],
  rs: [
    ['comment', '\\/\\/.*'],
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['attr', '#!?\\[\\w+'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['keyword', '\\b(?:fn|let|mut|const|if|else|match|for|while|loop|return|break|continue|struct|enum|impl|trait|pub|use|mod|crate|self|super|where|type|unsafe|async|await|move|ref|as|in|dyn|static|extern)\\b'],
    ['type', '\\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Self|Some|None|Ok|Err)\\b'],
    ['number', '\\b(?:true|false)\\b'],
    ['number', '\\b\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?\\b'],
  ],
  go: [
    ['comment', '\\/\\/.*'],
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['string', '`[^`]*`'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['keyword', '\\b(?:func|var|const|type|struct|interface|map|chan|if|else|for|range|switch|case|default|return|break|continue|go|defer|select|package|import|fallthrough)\\b'],
    ['type', '\\b(?:int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|complex64|complex128|byte|rune|string|bool|error|any)\\b'],
    ['number', '\\b(?:true|false|nil|iota)\\b'],
    ['number', '\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b'],
  ],
  java: [
    ['comment', '\\/\\/.*'],
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['attr', '@\\w+'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '\\b(?:public|private|protected|static|final|abstract|class|interface|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|import|package|void|this|super|synchronized|volatile|enum|assert|instanceof)\\b'],
    ['type', '\\b(?:int|long|short|byte|float|double|char|boolean|String|Integer|Long|Double|Boolean|List|Map|Set|Object|Class|void)\\b'],
    ['number', '\\b(?:true|false|null)\\b'],
    ['number', '\\b\\d+\\.?\\d*[fFdDlL]?\\b'],
  ],
  sh: [
    ['comment', '#.*'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'[^']*'"],
    ['keyword', '\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|exit|local|export|source|alias|readonly|declare|set|unset)\\b'],
    ['type', '\\$\\{?[\\w]+\\}?'],
    ['number', '\\b\\d+\\b'],
  ],
  yaml: [
    ['comment', '#.*'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'[^']*'"],
    ['keyword', '\\b(?:true|false|null|yes|no)\\b'],
    ['attr', '^\\s*[\\w][\\w\\s.-]*(?=\\s*:)'],
    ['number', '\\b\\d+\\.?\\d*\\b'],
  ],
  sql: [
    ['comment', '--.*'],
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '\\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|JOIN|INNER|LEFT|RIGHT|OUTER|ON|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|AS|DISTINCT|NULL|IS|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CHECK|UNIQUE|CASCADE|VALUES|BEGIN|COMMIT|ROLLBACK|IF|ELSE|THEN|END|CASE|WHEN|DECLARE|TRIGGER|PROCEDURE|FUNCTION|RETURNS|RETURN)\\b'],
    ['type', '\\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|VARCHAR|CHAR|TEXT|BLOB|DATE|TIME|DATETIME|TIMESTAMP|BOOLEAN|SERIAL|UUID)\\b'],
    ['type', '\\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|CONVERT|IFNULL|ISNULL)\\b'],
    ['number', '\\b\\d+\\.?\\d*\\b'],
  ],
  c: [
    ['comment', '\\/\\/.*'],
    ['comment', '\\/\\*[\\s\\S]*?\\*\\/'],
    ['attr', '#\\s*(?:include|define|ifdef|ifndef|endif|pragma|if|else|elif|undef|error|warning)\\b[^\\n]*'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '\\b(?:auto|break|case|const|continue|default|do|else|enum|extern|for|goto|if|inline|return|sizeof|static|struct|switch|typedef|union|volatile|while|class|namespace|template|typename|virtual|public|private|protected|new|delete|try|catch|throw|using|override|nullptr|constexpr|noexcept|decltype|static_assert)\\b'],
    ['type', '\\b(?:int|char|float|double|void|long|short|unsigned|signed|bool|size_t|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|FILE|string|vector|map|set|shared_ptr|unique_ptr|wchar_t|ptrdiff_t)\\b'],
    ['number', '\\b(?:true|false|NULL|nullptr)\\b'],
    ['number', '\\b(?:0[xX][\\da-fA-F]+|0[0-7]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)[uUlLfF]*\\b'],
  ],
  rb: [
    ['comment', '#.*'],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'(?:[^'\\\\]|\\\\.)*'"],
    ['keyword', '\\b(?:def|class|module|end|if|elsif|else|unless|while|until|for|do|begin|rescue|ensure|raise|return|yield|break|next|redo|retry|then|when|case|in|require|require_relative|include|extend|attr_reader|attr_writer|attr_accessor|self|super|nil|true|false|and|or|not|puts|print|p)\\b'],
    ['type', '\\b[A-Z]\\w+\\b'],
    ['type', ':\\w+'],
    ['number', '\\b\\d+\\.?\\d*\\b'],
  ],
  toml: [
    ['comment', '#.*'],
    ['string', '"""[\\s\\S]*?"""'],
    ['string', "'''[\\s\\S]*?'''"],
    ['string', '"(?:[^"\\\\]|\\\\.)*"'],
    ['string', "'[^']*'"],
    ['keyword', '\\b(?:true|false)\\b'],
    ['tag', '\\[\\[?[^\\]]+\\]\\]?'],
    ['attr', '^\\s*[\\w][\\w.-]*(?=\\s*=)'],
    ['number', '\\b\\d[\\d_]*\\.?\\d*\\b'],
  ],
  md: [
    ['tag', '^#{1,6}\\s.*'],
    ['string', '`[^`]+`'],
    ['keyword', '\\*\\*[^*]+\\*\\*'],
    ['comment', '\\[[^\\]]+\\]\\([^)]+\\)'],
    ['number', '^\\s*[-*+]\\s'],
    ['number', '^\\s*\\d+\\.\\s'],
  ],
};

// Flags per language (default: 'g')
const FLAGS = { sql: 'gi' };

// Compiled regex cache
const _compiled = {};
function getCompiled(lang) {
  if (_compiled[lang]) return _compiled[lang];
  const rules = R[lang];
  if (!rules) return null;
  const parts = rules.map(([, src]) => `(${src})`);
  const types = rules.map(([t]) => t);
  const flags = FLAGS[lang] || 'g';
  _compiled[lang] = { regex: new RegExp(parts.join('|'), flags), types };
  return _compiled[lang];
}

/**
 * Highlight a single line of code.
 * Takes raw (unescaped) text, returns HTML with <span class="hl-*"> wrappers.
 * Handles HTML escaping internally.
 */
export function highlightLine(rawLine, lang) {
  if (!lang || !rawLine) return esc(rawLine);

  // Strip diff prefix (+, -, space)
  let prefix = '';
  let code = rawLine;
  const ch = rawLine[0];
  if (ch === '+' || ch === '-') { prefix = ch; code = rawLine.slice(1); }
  else if (ch === ' ') { prefix = ' '; code = rawLine.slice(1); }

  const compiled = getCompiled(lang);
  if (!compiled || !code.trim()) return esc(rawLine);

  const { regex, types } = compiled;
  regex.lastIndex = 0; // reset for 'g' flag

  let result = '';
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(code)) !== null) {
    // Prevent infinite loops on zero-length matches
    if (match[0].length === 0) { regex.lastIndex++; continue; }

    // Add plain text before match
    if (match.index > lastIdx) {
      result += esc(code.slice(lastIdx, match.index));
    }

    // Find which group matched
    let tokenType = 'keyword';
    for (let i = 0; i < types.length; i++) {
      if (match[i + 1] !== undefined) { tokenType = types[i]; break; }
    }

    result += `<span class="hl-${tokenType}">${esc(match[0])}</span>`;
    lastIdx = match.index + match[0].length;
  }

  // Add remaining plain text
  if (lastIdx < code.length) {
    result += esc(code.slice(lastIdx));
  }

  return esc(prefix) + result;
}
