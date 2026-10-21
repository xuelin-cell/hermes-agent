const providerIdPattern = /^[a-z0-9_-]+$/;

/**
 * Check provider ids used as source directory names and catalog filenames.
 */
export function isProviderId(value: string): boolean {
  return providerIdPattern.test(value);
}

export function assertProviderId(value: string, label = "provider id"): void {
  if (!isProviderId(value)) {
    throw new Error(`${label} must match ${providerIdPattern.source}: ${value}`);
  }
}
