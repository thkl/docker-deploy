export function readMigratedLocalStorageKey(currentKey: string, legacyKey: string) {
  const currentValue = localStorage.getItem(currentKey);
  if (currentValue !== null) {
    return currentValue;
  }

  const legacyValue = localStorage.getItem(legacyKey);
  if (legacyValue !== null) {
    localStorage.setItem(currentKey, legacyValue);
    localStorage.removeItem(legacyKey);
  }

  return legacyValue;
}

export function readMigratedSessionStorageKey(currentKey: string, legacyKey: string) {
  const currentValue = sessionStorage.getItem(currentKey);
  if (currentValue !== null) {
    return currentValue;
  }

  const legacyValue = sessionStorage.getItem(legacyKey);
  if (legacyValue !== null) {
    sessionStorage.setItem(currentKey, legacyValue);
    sessionStorage.removeItem(legacyKey);
  }

  return legacyValue;
}

export function removeLocalStorageKeys(...keys: string[]) {
  for (const key of keys) {
    localStorage.removeItem(key);
  }
}

export function removeSessionStorageKeys(...keys: string[]) {
  for (const key of keys) {
    sessionStorage.removeItem(key);
  }
}
