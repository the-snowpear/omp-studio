export const UPDATE_CHECK_TIMEOUT_MS = 8_000;

export class UpdateCheckTimeoutError extends Error {
  readonly name = "UpdateCheckTimeoutError";

  constructor() {
    super("检查更新超时");
  }
}

export function isUpdateCheckTimeout(error: unknown): boolean {
  return error instanceof UpdateCheckTimeoutError;
}

export async function queryWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpdateCheckTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
