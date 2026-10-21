import type { ActionExecutor, CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createMailProviderRuntime } from "../../mail/imap-smtp/runtime.ts";
import { ProviderRequestError, toProviderExecutionError } from "../provider-runtime.ts";
import { woMailRuntimeConfig } from "./config.ts";
import { withWoMailQuota, WoMailQuotaExceededError } from "./quota.ts";

const runtime = createMailProviderRuntime(woMailRuntimeConfig);

const QUOTA_ACTIONS = ["send_email", "reply_email", "forward_email"] as const;

export function addWoMailQuota(
  base: ProviderExecutors,
  options: { dataDir?: () => string | undefined; now?: () => Date } = {},
): ProviderExecutors {
  const wrapped = { ...base };
  const dataDir = options.dataDir ?? (() => process.env.OOMOL_CONNECT_DATA_DIR);
  const now = options.now ?? (() => new Date());

  for (const action of QUOTA_ACTIONS) {
    const actionId = `wo_mail.${action}` as const;
    const execute = base[actionId];
    if (!execute) {
      continue;
    }
    wrapped[actionId] = quotaExecutor(execute, dataDir, now);
  }
  return wrapped;
}

function quotaExecutor(
  execute: ActionExecutor,
  dataDir: () => string | undefined,
  now: () => Date,
): ActionExecutor {
  return async (input, context) => {
    try {
      const directory = dataDir();
      if (!directory) {
        throw new Error("Wo Mail quota storage directory is unavailable.");
      }
      const credential = await context.getCredential("wo_mail");
      const email = credential && "values" in credential ? credential.values.email : undefined;
      if (!email) {
        throw new Error("Wo Mail quota requires an account email.");
      }
      return await withWoMailQuota(directory, email, () => execute(input, context), now());
    } catch (error) {
      if (error instanceof WoMailQuotaExceededError) {
        return toProviderExecutionError(new ProviderRequestError(429, error.message), "Wo Mail send failed.");
      }
      return toProviderExecutionError(error, "Wo Mail send failed.");
    }
  };
}

export const executors: ProviderExecutors = addWoMailQuota(runtime.executors);
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
