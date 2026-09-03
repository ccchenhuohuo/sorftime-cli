import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ValidationError } from "./errors.js";
import { OUTPUT_FORMATS } from "./types.js";
import type { OutputFormat, StoredConfig } from "./types.js";

const execFile = promisify(execFileCallback);
const KEYCHAIN_SERVICE = "com.sorftime.cli";
const KEYCHAIN_ACCOUNT = "account-sk";

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.SORFTIME_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sorftime");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "config.json");
}

function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "credentials.json");
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    // JSON parser messages may include source excerpts. Credential files and
    // mistakenly secret-bearing configs must never be reflected into stderr.
    if (error instanceof SyntaxError) throw new ValidationError(`Invalid JSON in ${path}.`);
    throw error;
  }
}

const SECRET_CONFIG_KEY = /(authorization|token|secret|password|account[-_]?sk)/iu;

function normalizeStoredConfig(value: unknown): StoredConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Sorftime config must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  const secretKey = Object.keys(raw).find((key) => SECRET_CONFIG_KEY.test(key));
  if (secretKey) {
    throw new ValidationError(`Secret-like key '${secretKey}' is not allowed in config.json. Remove it and use 'sorftime auth login'.`);
  }

  const config: StoredConfig = {};
  if (raw.domain !== undefined) {
    if (typeof raw.domain !== "string" && typeof raw.domain !== "number") throw new ValidationError("Config domain must be a string or number.");
    config.domain = raw.domain;
  }
  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== "string") throw new ValidationError("Config baseUrl must be a string.");
    config.baseUrl = raw.baseUrl;
  }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0) throw new ValidationError("Config timeoutMs must be a positive integer.");
    config.timeoutMs = raw.timeoutMs as number;
  }
  if (raw.output !== undefined) {
    if (typeof raw.output !== "string" || !OUTPUT_FORMATS.includes(raw.output as OutputFormat)) {
      throw new ValidationError("Config output format is invalid.");
    }
    config.output = raw.output as NonNullable<StoredConfig["output"]>;
  }
  return config;
}

async function atomicWriteJson(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<StoredConfig> {
  return normalizeStoredConfig(await readJsonFile<unknown>(configPath(env), {}));
}

export async function saveConfig(config: StoredConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWriteJson(configPath(env), normalizeStoredConfig(config), 0o600);
}

async function hasSecurityCommand(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (process.platform !== "darwin" || env.SORFTIME_CREDENTIAL_STORE === "file") return false;
  try {
    await access("/usr/bin/security", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readKeychainToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!(await hasSecurityCommand(env))) return undefined;
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readFileToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = credentialsPath(env);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new ValidationError(`Credential file ${path} must not be a symbolic link.`);
  }
  if (!metadata.isFile()) {
    throw new ValidationError(`Credential path ${path} must be a regular file.`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new ValidationError(`Credential file ${path} has unsafe permissions; run chmod 600 on it.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new ValidationError(`Credential file ${path} is not owned by the current user.`);
  }
  const credentials = await readJsonFile<{ accountSk?: string }>(path, {});
  return credentials.accountSk?.trim() || undefined;
}

export type TokenSource = "environment" | "keychain" | "file" | "missing";

export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token?: string; source: TokenSource }> {
  if (env.SORFTIME_ACCOUNT_SK?.trim()) return { token: env.SORFTIME_ACCOUNT_SK.trim(), source: "environment" };
  const keychain = await readKeychainToken(env);
  if (keychain) return { token: keychain, source: "keychain" };
  const file = await readFileToken(env);
  if (file) return { token: file, source: "file" };
  return { source: "missing" };
}

export async function saveToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<"keychain" | "file"> {
  const cleaned = token.trim();
  if (!cleaned) throw new ValidationError("Account-SK cannot be empty.");
  if (/[\r\n]/u.test(cleaned)) throw new ValidationError("Account-SK cannot contain line breaks.");

  await atomicWriteJson(credentialsPath(env), { accountSk: cleaned }, 0o600);
  return "file";
}

export async function deleteToken(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let deleted = false;
  if (await hasSecurityCommand(env)) {
    try {
      await execFile("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
      deleted = true;
    } catch {
      // A missing Keychain item is equivalent to an already logged-out state.
    }
  }
  try {
    await unlink(credentialsPath(env));
    deleted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return deleted;
}
