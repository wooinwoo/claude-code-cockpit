// ─── Action Registry ───
// Decentralized event delegation: each module registers its own action handlers.
const clickActions = new Map();
const changeActions = new Map();
const inputActions = new Map();
const keydownActions = new Map();

export function registerClickActions(map) {
  for (const [k, v] of Object.entries(map)) clickActions.set(k, v);
}
export function registerChangeActions(map) {
  for (const [k, v] of Object.entries(map)) changeActions.set(k, v);
}
export function registerInputActions(map) {
  for (const [k, v] of Object.entries(map)) inputActions.set(k, v);
}
export function registerKeydownActions(map) {
  for (const [k, v] of Object.entries(map)) keydownActions.set(k, v);
}

export function getClickAction(name) { return clickActions.get(name); }
export function getChangeAction(name) { return changeActions.get(name); }
export function getInputAction(name) { return inputActions.get(name); }
export function getKeydownAction(name) { return keydownActions.get(name); }
