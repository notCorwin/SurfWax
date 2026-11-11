export type ScriptDiagnostic = "match" | "syntax";

export class ScriptRegistrationError extends Error {
  constructor(readonly diagnostic: ScriptDiagnostic, cause: unknown) {
    super("User script registration failed", { cause });
  }
}

// Chrome owns these errors; classify them only at the registration boundary.
export async function registerScript(api: Pick<typeof chrome.userScripts, "register">, script: chrome.userScripts.RegisteredUserScript) {
  try { await api.register([script]); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/invalid.*match|match.*invalid|invalid.*pattern/i.test(message)) throw new ScriptRegistrationError("match", error);
    if (/syntax|unexpected token/i.test(message)) throw new ScriptRegistrationError("syntax", error);
    throw error;
  }
}
