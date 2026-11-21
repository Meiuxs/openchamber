let debugLogging = false;

export function isDebugLogging(): boolean {
  return debugLogging;
}

export function setDebugLogging(enabled: boolean): void {
  debugLogging = enabled;
}
