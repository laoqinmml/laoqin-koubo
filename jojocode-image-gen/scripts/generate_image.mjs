#!/usr/bin/env node
/**
 * Generate images through the JojoCode OpenAI-compatible endpoint and save them
 * to local files.
 *
 * Usage:
 *   node generate_image.mjs --prompt "a red apple" [options]
 *
 * Options:
 *   --prompt <text>          Image prompt. Required unless --prompt-file is used.
 *   --prompt-file <path>     Read the prompt from a UTF-8 file (long/CJK prompts).
 *   --out <path>             Output file or directory. Default: ./outputs/
 *   --size <WxH|auto>        Default: 1024x1024
 *   --quality <level>        Passed through when set (e.g. low, medium, high).
 *   --background <value>     Passed through when set (e.g. transparent, opaque).
 *   --output-format <fmt>    png | jpeg | webp. Default: png
 *   --model <name>           Default: gpt-image-2
 *   --n <count>              Number of images. Default: 1
 *   --base-url <url>         Default: https://jojocode.com
 *   --api-key <key>          Default: JOJOCODE_API_KEY env var, then built-in key.
 *   --timeout <seconds>      Per-request timeout. Default: 300
 *   --extra <json>           Extra JSON merged into the request body.
 *
 * Credential modes (no prompt or generation needed):
 *   --save-key <key>         Store the key in the local config file, then exit.
 *   --check-key              Report whether a key is configured (never prints it).
 *   --clear-key              Delete the stored key, then exit.
 *
 * Exit codes: 0 ok, 1 usage/API error, 3 missing API key.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://jojocode.com";
const DEFAULT_MODEL = "gpt-image-2";
const ALLOWED_FORMATS = new Set(["png", "jpeg", "jpg", "webp"]);
const MISSING_KEY_EXIT = 3;

function configPath() {
  if (process.env.JOJOCODE_CONFIG) return path.resolve(process.env.JOJOCODE_CONFIG);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "jojocode-image-gen", "config.json");
}

async function readConfig() {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`Stored config at ${file} is not valid JSON: ${error.message}`);
  }
}

async function writeConfig(patch) {
  const file = configPath();
  const merged = { ...(await readConfig()), ...patch };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows and some filesystems ignore POSIX modes; the file is still local.
  }
  return file;
}

async function clearStoredKey() {
  const file = configPath();
  const remaining = await readConfig();
  delete remaining.apiKey;
  if (Object.keys(remaining).length === 0) {
    await rm(file, { force: true });
    return file;
  }
  await writeFile(file, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Resolution order: --api-key, JOJOCODE_API_KEY, stored config. */
async function resolveApiKey(opts) {
  const oneOff = (opts["api-key"] ?? "").trim();
  if (oneOff) return { key: oneOff, source: "--api-key" };
  const fromEnv = (process.env.JOJOCODE_API_KEY ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "JOJOCODE_API_KEY" };
  const stored = ((await readConfig()).apiKey ?? "").trim();
  if (stored) return { key: stored, source: configPath() };
  return null;
}

function parseArgs(argv) {
  const opts = {};
  const flags = new Set([
    "--save-key",
    "--prompt",
    "--prompt-file",
    "--out",
    "--size",
    "--quality",
    "--background",
    "--output-format",
    "--model",
    "--n",
    "--base-url",
    "--api-key",
    "--timeout",
    "--extra",
  ]);
  const switches = new Set(["--check-key", "--clear-key"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (switches.has(arg)) {
      opts[arg.slice(2)] = true;
      continue;
    }
    if (!flags.has(arg)) {
      fail(`Unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for ${arg}`);
    }
    opts[arg.slice(2)] = value;
    i += 1;
  }
  return opts;
}

function fail(message) {
  console.error(`[jojocode-image-gen] error: ${message}`);
  process.exit(1);
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function extensionFor(buffer, declared) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF") return "webp";
  return declared === "jpg" ? "jpeg" : declared;
}

async function resolvePrompt(opts) {
  if (opts.prompt && opts["prompt-file"]) {
    fail("Use either --prompt or --prompt-file, not both.");
  }
  if (opts["prompt-file"]) {
    const text = await readFile(opts["prompt-file"], "utf8");
    return text.trim();
  }
  return (opts.prompt ?? "").trim();
}

function outputTarget(opts, format, count) {
  const raw = opts.out ?? "outputs";
  const resolved = path.resolve(raw);
  const extension = path.extname(resolved);
  // A path with a file extension is a file; anything else is a directory.
  const looksLikeDir =
    raw.endsWith("/") ||
    raw.endsWith("\\") ||
    extension === "" ||
    (existsSync(resolved) && statSync(resolved).isDirectory());

  if (looksLikeDir) {
    const stem = `jojocode-${timestamp()}`;
    return {
      directory: resolved,
      fileFor: (index) => path.join(resolved, `${stem}-${index + 1}.${format}`),
    };
  }

  const directory = path.dirname(resolved);
  if (count === 1) {
    return { directory, fileFor: () => resolved };
  }
  const stem = resolved.slice(0, -extension.length);
  return {
    directory,
    fileFor: (index) => `${stem}-${index + 1}${extension}`,
  };
}

async function requestImages(endpoint, apiKey, body, timeoutSeconds) {
  const attempts = 3;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      const text = await response.text();
      if (response.ok) {
        try {
          return JSON.parse(text);
        } catch {
          fail(`Endpoint returned non-JSON success body: ${text.slice(0, 500)}`);
        }
      }
      lastError = `HTTP ${response.status}: ${text.slice(0, 500)}`;
      const retryable =
        response.status === 429 || response.status === 408 || response.status >= 500;
      if (!retryable) {
        fail(`Request rejected by ${endpoint} (${lastError})`);
      }
    } catch (error) {
      lastError = `${error?.name ?? "Error"}: ${error?.message ?? error}`;
    }
    if (attempt < attempts) {
      const waitMs = attempt * 5000;
      console.error(
        `[jojocode-image-gen] attempt ${attempt} failed (${lastError}); retrying in ${waitMs / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  fail(`Request to ${endpoint} failed after ${attempts} attempts (${lastError})`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts["save-key"] !== undefined) {
    const key = opts["save-key"].trim();
    if (!key) fail("--save-key requires a non-empty value.");
    const file = await writeConfig({ apiKey: key });
    console.log(JSON.stringify({ keyStored: true, config: file }));
    return;
  }

  if (opts["clear-key"]) {
    const file = await clearStoredKey();
    console.log(JSON.stringify({ keyCleared: true, config: file }));
    return;
  }

  const credential = await resolveApiKey(opts);

  if (opts["check-key"]) {
    console.log(
      JSON.stringify(
        {
          keyConfigured: Boolean(credential),
          source: credential?.source ?? null,
          configPath: configPath(),
          next: credential
            ? "Ready. Do not print the key."
            : "Ask the user for their JojoCode API key, then run --save-key <KEY>.",
        },
        null,
        2,
      ),
    );
    if (!credential) process.exit(MISSING_KEY_EXIT);
    return;
  }

  if (!credential) {
    console.error(
      [
        "[jojocode-image-gen] missing-api-key: no JojoCode API key is configured.",
        `Checked --api-key, JOJOCODE_API_KEY, and ${configPath()}.`,
        "Ask the user for their JojoCode API key in plain text, then store it once:",
        '  node "<skill-dir>/scripts/generate_image.mjs" --save-key "<KEY>"',
        "Never echo the key back into the chat, and never write it into the skill or a repo.",
      ].join("\n"),
    );
    process.exit(MISSING_KEY_EXIT);
  }

  const prompt = await resolvePrompt(opts);
  if (!prompt) fail("A non-empty --prompt (or --prompt-file) is required.");

  const format = (opts["output-format"] ?? "png").toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) {
    fail(`Unsupported --output-format '${format}'. Use png, jpeg, or webp.`);
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const count = Number.parseInt(opts.n ?? "1", 10);
  if (!Number.isInteger(count) || count < 1) fail("--n must be a positive integer.");

  const timeoutSeconds = Number.parseFloat(opts.timeout ?? "300");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    fail("--timeout must be a positive number of seconds.");
  }

  const baseUrl = normalizeBaseUrl(
    opts["base-url"] ||
      process.env.JOJOCODE_BASE_URL ||
      (await readConfig()).baseUrl ||
      DEFAULT_BASE_URL,
  );
  const endpoint = `${baseUrl}/images/generations`;

  const body = {
    model,
    prompt,
    n: count,
    size: opts.size ?? "1024x1024",
    output_format: format,
  };
  for (const key of ["quality", "background"]) {
    if (opts[key]) body[key] = opts[key];
  }
  if (opts.extra) {
    try {
      Object.assign(body, JSON.parse(opts.extra));
    } catch {
      fail("--extra must be a JSON object.");
    }
  }

  console.error(
    `[jojocode-image-gen] POST ${endpoint} model=${body.model} size=${body.size} n=${body.n}`,
  );
  const payload = await requestImages(
    endpoint,
    credential.key,
    body,
    timeoutSeconds,
  );
  const items = Array.isArray(payload?.data) ? payload.data : [];
  if (items.length === 0) {
    fail(`Response contained no image data: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const target = outputTarget(opts, format, items.length);
  await mkdir(target.directory, { recursive: true });

  const saved = [];
  for (const [index, item] of items.entries()) {
    let buffer;
    if (item?.b64_json) {
      buffer = Buffer.from(item.b64_json, "base64");
    } else if (item?.url) {
      const download = await fetch(item.url, {
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      if (!download.ok) fail(`Failed to download ${item.url} (HTTP ${download.status})`);
      buffer = Buffer.from(await download.arrayBuffer());
    } else {
      fail(`Image ${index + 1} had neither b64_json nor url.`);
    }

    const declared = format === "jpg" ? "jpeg" : format;
    const extension = extensionFor(buffer, declared);
    let filePath = target.fileFor(index);
    const actual = extension === "jpeg" && format !== "jpeg" ? "jpg" : extension;
    const currentExtension = path.extname(filePath);
    const normalize = (value) => (value === "jpeg" ? "jpg" : value);
    if (
      currentExtension &&
      normalize(currentExtension.slice(1).toLowerCase()) !== normalize(actual)
    ) {
      filePath = filePath.slice(0, -currentExtension.length) + `.${actual}`;
    }
    await writeFile(filePath, buffer);
    saved.push(path.resolve(filePath));
    console.error(
      `[jojocode-image-gen] saved: ${path.resolve(filePath)} (${(buffer.length / 1024).toFixed(1)} KB)`,
    );
  }

  if (payload.usage) {
    console.error(`[jojocode-image-gen] usage: ${JSON.stringify(payload.usage)}`);
  }
  console.log(JSON.stringify({ model, size: body.size, saved }, null, 2));
}

await main();
