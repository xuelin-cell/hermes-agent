import type { CredentialDefinition } from "./types.ts";

import { stringRecord } from "./cast.ts";

/**
 * Error factory used when credential field validation fails.
 */
export type CredentialFieldErrorFactory = (message: string) => Error;

/**
 * Options for normalizing provider-declared credential fields.
 */
export type NormalizeCredentialValuesOptions = {
  fields: CredentialDefinition[];
  values: Record<string, unknown>;
  createError: CredentialFieldErrorFactory;
};

/**
 * Return trimmed credential values after enforcing a provider field contract.
 *
 * This keeps local connection APIs aligned with the public provider catalog:
 * callers may only submit fields declared by the provider, and required fields
 * must contain non-empty string values.
 */
export function normalizeCredentialValues(options: NormalizeCredentialValuesOptions): Record<string, string> {
  const values = stringRecord(options.values);
  const fieldsByKey = new Map(options.fields.map((field) => [field.key, field]));

  for (const key of Object.keys(values)) {
    if (!fieldsByKey.has(key)) {
      throw options.createError(`Unexpected credential field: ${key}.`);
    }
  }

  for (const field of options.fields) {
    if (field.required && !values[field.key]) {
      throw options.createError(`${field.key} is required.`);
    }
  }

  return values;
}
