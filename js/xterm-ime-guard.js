// Compatibility patch for xterm.js#6089 and Windows TSF textarea replacement.
// Remove this after the bundled xterm includes both upstream fixes.
const patchedHelpers = new WeakSet();

function canAssign(target, key) {
  let owner = target;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) {
      if ('set' in descriptor) return typeof descriptor.set === 'function';
      return descriptor.writable === true && (owner === target || Object.isExtensible(target));
    }
    owner = Object.getPrototypeOf(owner);
  }
  return Object.isExtensible(target);
}

export function patchXtermImeComposition(xterm) {
  const helper = xterm?._core?._compositionHelper;
  if (!helper) return false;
  if (patchedHelpers.has(helper) || Array.isArray(helper._pendingSends)) return true;
  const textarea = helper._textarea;
  const mutableKeys = ['_isSendingComposition', 'compositionstart', 'compositionend', 'keydown', '_finalizeComposition'];
  if (!(helper._compositionPosition
    && textarea
    && helper._compositionView?.classList
    && typeof textarea.addEventListener === 'function'
    && typeof helper._coreService?.triggerDataEvent === 'function'
    && typeof helper.compositionstart === 'function'
    && typeof helper.compositionend === 'function'
    && typeof helper.keydown === 'function'
    && typeof helper._finalizeComposition === 'function'
    && typeof helper._handleAnyTextareaChanges === 'function'
    && typeof helper._dataAlreadySent === 'string'
    && mutableKeys.every(key => canAssign(helper, key))
    && canAssign(helper._compositionPosition, 'end'))) return false;

  const originals = new Map(mutableKeys.map(key => [key, Object.getOwnPropertyDescriptor(helper, key)]));
  const originalCompositionstart = helper.compositionstart;
  const pendingSends = [];
  const committedData = [];
  let sentUpTo = 0;

  const sliceUnsent = (start, end) => {
    const from = Math.max(start, sentUpTo);
    const to = Math.max(from, end);
    sentUpTo = Math.max(sentUpTo, to);
    return textarea.value.substring(from, to);
  };
  const onCompositionEnd = event => {
    committedData.push(typeof event.data === 'string' ? event.data : '');
  };
  const compositionstart = function () {
    originalCompositionstart.call(this);
    this._compositionPosition.end = this._compositionPosition.start;
    sentUpTo = Math.min(sentUpTo, this._compositionPosition.start);
  };
  const compositionend = function () {
    this._finalizeComposition(true, committedData.shift() || '');
  };
  const keydown = function (event) {
    if (this._isComposing || pendingSends.length) {
      if (event.keyCode === 20 || event.keyCode === 229) return false;
      if (event.keyCode === 16 || event.keyCode === 17 || event.keyCode === 18) return false;
      this._finalizeComposition(false);
    }
    if (event.keyCode !== 229) return true;
    this._handleAnyTextareaChanges();
    return false;
  };
  const finalizeComposition = function (waitForPropagation, committed = '') {
    this._compositionView.classList.remove('active');
    this._isComposing = false;

    if (!waitForPropagation) {
      for (const send of pendingSends.splice(0)) send();
      const end = Math.max(
        this._compositionPosition.end,
        this._textarea.selectionEnd ?? this._compositionPosition.end,
      );
      const input = sliceUnsent(this._compositionPosition.start, end);
      if (input) this._coreService.triggerDataEvent(input, true);
      return;
    }

    const position = { ...this._compositionPosition };
    const alreadySentLength = this._dataAlreadySent.length;
    const send = () => {
      position.start += alreadySentLength;
      const end = this._compositionPosition.start > position.start
        ? this._compositionPosition.start
        : this._textarea.value.length;
      const sentBefore = sentUpTo;
      const input = sliceUnsent(position.start, end);
      const wasCovered = sentBefore > position.start;
      const output = committed && !wasCovered && input.length < committed.length ? committed : input;
      if (output) this._coreService.triggerDataEvent(output, true);
    };
    pendingSends.push(send);
    setTimeout(() => {
      const index = pendingSends.indexOf(send);
      if (index === -1) return;
      pendingSends.splice(index, 1);
      send();
    }, 0);
  };

  try {
    helper._isSendingComposition = false;
    helper.compositionstart = compositionstart;
    helper.compositionend = compositionend;
    helper.keydown = keydown;
    helper._finalizeComposition = finalizeComposition;
    textarea.addEventListener('compositionend', onCompositionEnd, true);
    patchedHelpers.add(helper);
    return true;
  } catch {
    if (typeof textarea.removeEventListener === 'function') {
      textarea.removeEventListener('compositionend', onCompositionEnd, true);
    }
    for (const [key, descriptor] of originals) {
      try {
        if (descriptor) Object.defineProperty(helper, key, descriptor);
        else delete helper[key];
      } catch { /* best-effort rollback for unknown xterm internals */ }
    }
    return false;
  }
}
