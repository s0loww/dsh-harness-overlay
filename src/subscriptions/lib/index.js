import { isAbsolute } from "node:path";
import z from "@deepseek-ai/schemastery";
import * as llm from "@deepseek-ai/dsh-llm";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, attributionHeaders, errorChain, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ProxyAgent, fetch as fetch$1 } from "undici";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/auth/pkce.ts
/**
* Base64url-encode without padding.
* @param buffer - raw bytes.
* @returns the RFC 4648 §5 encoding.
*/
function base64url(buffer) {
	return buffer.toString("base64url");
}
/**
* Mint a fresh PKCE pair (32-byte verifier, S256 challenge).
* @returns the pair for one authorization attempt.
*/
function createPkce() {
	const verifier = base64url(randomBytes(32));
	return {
		verifier,
		challenge: base64url(createHash("sha256").update(verifier).digest())
	};
}
/**
* Mint a URL-safe random token (default 16 bytes) for OAuth `state`.
* @param bytes - entropy length.
* @returns base64url-encoded random bytes.
*/
function randomToken(bytes = 32) {
	return base64url(randomBytes(bytes));
}
/**
* Mint lowercase-hex random bytes (for Grok's `nonce` parameter).
* @param bytes - entropy length; the hex string is twice as long.
* @returns hex-encoded random bytes.
*/
function randomHex(bytes = 8) {
	return randomBytes(bytes).toString("hex");
}

//#endregion
//#region src/auth/oauth-flow.ts
/** Default attempt lifetime: three minutes for the user to complete login. */
const DEFAULT_FLOW_TIMEOUT_MS = 18e4;
const SUCCESS_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Login successful</title></head><body style=\"font-family:sans-serif\"><h1>Login successful</h1><p>You can close this tab and return to DeepSeek Harness.</p></body></html>";
function failurePage(detail) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head><body style="font-family:sans-serif"><h1>Login failed</h1><p>${detail.replace(/[<>&]/g, "")}</p></body></html>`;
}
/**
* Loopback addresses one listen host covers. `localhost` resolves to ::1 or
* 127.0.0.1 depending on the client, and Node binds exactly one of them per
* listen call — a browser picking the other family gets connection-refused
* and the login times out, so both families must serve the callback.
*/
function listenHosts(host) {
	return host === "localhost" ? ["127.0.0.1", "::1"] : [host];
}
/** True when the address family does not exist on this machine (safe to skip), unlike a taken port. */
function familyUnavailable(error) {
	const code = error.code;
	return code === "EADDRNOTAVAIL" || code === "EPROTONOSUPPORT";
}
/**
* Listen on the first port of the spec free on every loopback family;
* rejects when every port fails. Ephemeral ports (0) are retried so each
* family can be re-bound onto the first family's assigned port.
*/
async function listen(handler, spec) {
	const hosts = listenHosts(spec.host);
	const candidates = spec.ports.flatMap((port) => port === 0 ? [
		0,
		0,
		0
	] : [port]);
	let lastError;
	for (const candidate of candidates) {
		const servers = [];
		let port = candidate;
		let unusable = false;
		for (const host of hosts) {
			const server = createServer(handler);
			try {
				await new Promise((resolve, reject) => {
					const onError = (error) => reject(error);
					server.once("error", onError);
					server.listen(port, host, () => {
						server.removeListener("error", onError);
						resolve();
					});
				});
				const address = server.address();
				if (address === null) throw new Error(`callback server on ${host}:${port} has no address`);
				if (port === 0) port = address.port;
				servers.push(server);
			} catch (error) {
				server.close();
				if (familyUnavailable(error)) continue;
				lastError = error;
				unusable = true;
				break;
			}
		}
		if (unusable || servers.length === 0) {
			for (const server of servers) server.close();
			continue;
		}
		return {
			servers,
			port
		};
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`callback server could not listen on ${spec.host} (ports ${spec.ports.join(", ")})`);
}
/**
* Own the set of in-flight login attempts, keyed by provider. One attempt per
* provider at a time; an attempt removes itself when it settles.
*/
var OAuthFlowManager = class {
	attempts = /* @__PURE__ */ new Map();
	/**
	* Whether a login attempt is running for one provider.
	* @param provider - the provider route.
	* @returns true while an attempt is waiting for its code.
	*/
	isBusy(provider) {
		return this.attempts.has(provider);
	}
	/**
	* The pending attempt for one provider, when any.
	* @param provider - the provider route.
	* @returns the in-flight attempt, or `undefined`.
	*/
	pending(provider) {
		return this.attempts.get(provider);
	}
	/**
	* Start a login attempt: mint PKCE/state, open the loopback callback
	* server, and build the authorize URL.
	* @param provider - the provider route (one attempt at a time).
	* @param spec - static flow facts for this provider.
	* @returns the live attempt; its `waitCode()` settles the login.
	* @throws when an attempt is already running or no callback port is free.
	*/
	async start(provider, spec) {
		if (this.attempts.has(provider)) throw new Error(`a ${provider} login attempt is already in progress`);
		const input = {
			redirectUri: "",
			state: randomToken(32),
			pkce: createPkce(),
			nonce: randomHex(8)
		};
		const timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
		let resolveCode;
		let rejectCode;
		const codePromise = new Promise((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});
		let settled = false;
		let timer;
		let servers = [];
		const handler = (request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== spec.callbackPath) {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("not found");
				return;
			}
			const errorDescription = url.searchParams.get("error_description") ?? url.searchParams.get("error");
			if (errorDescription !== null) {
				response.writeHead(200, { "content-type": "text/html" });
				response.end(failurePage(errorDescription));
				settle(/* @__PURE__ */ new Error(`authorization failed: ${errorDescription}`));
				return;
			}
			if (url.searchParams.get("state") !== input.state) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("state mismatch");
				return;
			}
			const code = url.searchParams.get("code");
			if (code === null || code.length === 0) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("missing authorization code");
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(SUCCESS_PAGE);
			settle(void 0, code);
		};
		const settle = (error, code) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			for (const server of servers) {
				server.close();
				server.closeAllConnections();
			}
			this.attempts.delete(provider);
			if (error !== void 0) rejectCode(error);
			else if (code !== void 0) resolveCode(code);
		};
		const bound = await listen(handler, spec.listen);
		servers = bound.servers;
		input.redirectUri = `http://${spec.listen.host}:${bound.port}${spec.callbackPath}`;
		timer = setTimeout(() => {
			settle(/* @__PURE__ */ new Error(`login timed out after ${Math.round(timeoutMs / 1e3)}s`));
		}, timeoutMs);
		timer.unref();
		const attempt = {
			authorizeUrl: spec.buildAuthorizeUrl(input),
			redirectUri: input.redirectUri,
			pkce: input.pkce,
			state: input.state,
			waitCode: () => codePromise,
			manual(rawInput) {
				if (settled) throw new Error(`the ${provider} login attempt already finished`);
				const trimmed = rawInput.trim();
				let code;
				let pastedState;
				if (/^https?:\/\//i.test(trimmed)) {
					const url = new URL(trimmed);
					code = url.searchParams.get("code") ?? void 0;
					pastedState = url.searchParams.get("state") ?? void 0;
				} else if (trimmed.includes("code=")) {
					const params = new URLSearchParams(trimmed);
					code = params.get("code") ?? void 0;
					pastedState = params.get("state") ?? void 0;
				} else if (trimmed.length > 0 && !/\s/.test(trimmed)) code = trimmed;
				if (code === void 0 || code.length === 0) throw new Error("no authorization code found in the pasted input");
				if (pastedState !== void 0 && pastedState !== input.state) throw new Error("state mismatch: the pasted URL belongs to a different login attempt");
				settle(void 0, code);
			},
			cancel() {
				settle(/* @__PURE__ */ new Error("login cancelled"));
			}
		};
		this.attempts.set(provider, attempt);
		return attempt;
	}
};

//#endregion
//#region src/http.ts
/**
* undici's own fetch, typed to the DOM fetch signature: its bundled types are
* stricter (Request requires `duplex`, `RequestInit.body` is non-null) and
* incompatible with the DOM shapes the provider code passes. The runtime
* object is the same Web-fetch implementation Node uses.
*/
const dispatchFetch = fetch$1;
/** Destination the `proxyTest` endpoint probes when none is given. */
const DEFAULT_PROXY_TEST_URL = "https://api.x.ai/v1/models";
/** Probe deadline; a hung proxy must not pin the Settings dialog forever. */
const DEFAULT_PROXY_TEST_TIMEOUT_MS = 15e3;
/** Disabled configuration: the module state before the first load. */
const DISABLED = {
	enabled: false,
	url: "",
	bypass: []
};
/** Current config; updated by every load/apply/save. */
let current$1 = DISABLED;
/** The live dispatcher, or undefined when proxies are off/errored. */
let agent;
/** Last load/apply failure, surfaced by the config view. */
let configError;
/** One lazy load of the on-disk config (module-import cheap; file read once). */
let ready$1;
/** Absolute path of the proxy config file. */
function proxyFilePath() {
	return dshHomePath("plugins", "airules-subscriptions", "proxy.json");
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Flatten a fetch failure into a readable message: undici wraps the true
* cause (`connect ECONNREFUSED ...`) behind a bare "fetch failed", so walk
* the cause chain and append each distinct layer (up to four, cycle-safe).
* A hostname resolving to several addresses (e.g. `localhost` → ::1 and
* 127.0.0.1) fails as an `AggregateError` with an empty message, so its
* per-address `errors` entries are folded in too.
*/
function describeFetchError(error) {
	const parts = [];
	let node = error;
	for (let depth = 0; depth < 4 && node !== void 0 && node !== null; depth += 1) {
		const layer = node;
		if (Array.isArray(layer.errors)) for (const child of layer.errors) {
			const childText = child instanceof Error && child.message !== "" ? child.message : String(child);
			if (childText !== "" && !parts.includes(childText)) parts.push(childText);
		}
		let text = layer instanceof Error ? layer.message : String(node);
		const code = layer.code;
		if (typeof code === "string" && code !== "") {
			if (text === "") text = code;
			else if (!text.includes(code)) text = `${text} (${code})`;
		}
		if (text !== "" && !parts.includes(text)) parts.push(text);
		const next = layer.cause;
		if (next === void 0 || next === null || next === node) break;
		node = next;
	}
	return parts.join(" → ");
}
function withError(error) {
	configError = errorMessage(error);
}
/**
* Parse and validate a proxy URL. Only HTTP(S) proxies are supported because
* the undici dispatcher speaks CONNECT over HTTP; socks5 is not supported.
* @param raw - the URL the user configured.
* @returns the parsed URL (credentials attached by the caller).
*/
function parseProxyUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`proxy URL "${raw}" is not a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`proxy URL must use the http:// or https:// scheme (got "${raw}")`);
	if (url.hostname === "") throw new Error("proxy URL must include a host");
	return url;
}
/**
* Whether a request hostname bypasses the proxy.
* @param hostname - the request's hostname.
* @param entries - configured bypass entries: exact host, plain suffix
*   (`example.com` also matches `api.example.com`), or `*.example.com`.
*/
function matchesBypass(hostname, entries) {
	const host = hostname.toLowerCase();
	for (const raw of entries) {
		let entry = raw.trim().toLowerCase();
		if (entry === "") continue;
		if (entry.includes("://")) try {
			entry = new URL(entry).hostname;
		} catch {
			continue;
		}
		entry = entry.replace(/:\d+$/, "");
		if (entry === "" || entry === "*") continue;
		if (entry.startsWith("*.")) {
			if (host.endsWith(entry.slice(1))) return true;
		} else if (host === entry || host.endsWith(`.${entry}`)) return true;
	}
	return false;
}
/** Validate and normalize one config (throws with a user-facing message). */
function normalizeConfig(input) {
	const url = input.url.trim();
	if (input.enabled && url === "") throw new Error("a proxy URL is required when the proxy is enabled");
	if (url !== "") parseProxyUrl(url);
	const bypass = Array.from(new Set((input.bypass ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "")));
	return {
		enabled: input.enabled,
		url,
		...input.username !== void 0 && input.username !== "" ? { username: input.username.trim() } : {},
		...input.password !== void 0 && input.password !== "" && input.password !== null ? { password: input.password } : {},
		bypass
	};
}
/** Build the undici agent for a config (throws on an unusable URL). */
function buildAgent(cfg) {
	if (!cfg.enabled || cfg.url === "") return void 0;
	const url = parseProxyUrl(cfg.url);
	if (cfg.username !== void 0) url.username = cfg.username;
	if (cfg.password !== void 0) url.password = cfg.password;
	return new ProxyAgent(url.toString());
}
/** Swap in a config and its agent; a failed agent falls back to host routing. */
async function applyConfig(cfg) {
	let next;
	if (cfg !== void 0) {
		configError = void 0;
		try {
			next = buildAgent(cfg);
		} catch (error) {
			withError(error);
			next = void 0;
		}
		current$1 = cfg;
	}
	const previous = agent;
	agent = next;
	if (previous !== void 0) previous.close().catch(() => void 0);
}
/** Read the on-disk config. A missing file is the disabled default. */
async function loadConfigFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return {
			...DISABLED,
			bypass: []
		};
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`subscriptions proxy config at ${path} is not valid JSON; fix or delete the file`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("subscriptions proxy config must be a JSON object");
	const record = parsed;
	const enabled = record.enabled === true;
	const url = typeof record.url === "string" ? record.url : "";
	const username = typeof record.username === "string" ? record.username : void 0;
	const password = typeof record.password === "string" ? record.password : void 0;
	const bypass = Array.isArray(record.bypass) ? record.bypass.filter((entry) => typeof entry === "string") : [];
	return normalizeConfig({
		enabled,
		url,
		...username === void 0 ? {} : { username },
		...password === void 0 ? {} : { password },
		bypass
	});
}
/** Resolve the module state once from disk; failures disable the proxy. */
async function ensureReady$1() {
	ready$1 ??= loadConfigFile(proxyFilePath()).then(async (cfg) => {
		await applyConfig(cfg);
		return current$1;
	}, async (error) => {
		withError(error);
		await applyConfig(void 0);
		return current$1;
	});
	return ready$1;
}
/** Persist a config atomically with owner-only permissions, then apply it. */
async function persistConfig(cfg, path) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 384 });
		await chmod(tmp, 384);
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Current proxy config as served to the client (secrets omitted).
* @returns the view; {@link ProxyConfigView.error} carries the last
*   load/apply failure when the stored config is unusable.
*/
async function proxyGetConfig() {
	await ensureReady$1();
	return {
		enabled: current$1.enabled,
		url: current$1.url,
		...current$1.username === void 0 ? {} : { username: current$1.username },
		passwordSet: current$1.password !== void 0 && current$1.password !== "",
		bypass: [...current$1.bypass],
		...configError === void 0 ? {} : { error: configError }
	};
}
/**
* Validate, persist, and apply one proxy config. A `password` of `undefined`
* keeps the stored value; `null` or `''` clears it.
* @param input - the client's payload.
* @returns the resulting view (secrets omitted).
*/
async function proxySetConfig(input) {
	await ensureReady$1();
	const password = input.password === void 0 ? current$1.password : input.password === null || input.password === "" ? void 0 : input.password;
	const next = normalizeConfig({
		enabled: input.enabled,
		url: input.url,
		...input.username === void 0 ? {} : { username: input.username },
		...password === void 0 ? {} : { password },
		bypass: input.bypass ?? current$1.bypass
	});
	await persistConfig(next, proxyFilePath());
	await applyConfig(next);
	return proxyGetConfig();
}
/**
* The fetch caller all subscription code uses: routes through the configured
* proxy unless the host bypasses it. Identity-passthrough otherwise: the host
* may itself route global fetch through an environment-configured proxy.
*
* Proxied requests run on undici's own fetch (not the global one) so the
* ProxyAgent dispatcher always comes from the same undici build the request
* is issued with — a mismatched dispatcher can be silently ignored by the
* host's global fetch.
*/
async function proxiedFetch(input, init = {}) {
	await ensureReady$1();
	let dispatcher;
	if (current$1.enabled && agent !== void 0) {
		let hostname = "";
		try {
			hostname = (typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url)).hostname;
		} catch {
			hostname = "";
		}
		if (!matchesBypass(hostname, current$1.bypass)) dispatcher = agent;
	}
	if (dispatcher === void 0) return fetch(input, init);
	return dispatchFetch(input, {
		...init,
		dispatcher
	});
}
/**
* Probe a destination through a proxy, answering with the HTTP status or a
* flattened transport error. The probe uses `draft` when given (the dialog's
* current inputs, without saving) and the stored config otherwise.
* @param target - `http(s)` URL to fetch; defaults to {@link DEFAULT_PROXY_TEST_URL}.
* @param draft - unsaved proxy inputs to test; absent means the stored config.
* @returns the result; any HTTP status counts as a successful connection,
*   only a transport failure is an error.
*/
async function proxyTestConnection(target = DEFAULT_PROXY_TEST_URL, draft) {
	let parsed;
	try {
		parsed = new URL(target);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return {
			ok: false,
			viaProxy: false,
			error: `test destination must be http or https (got "${parsed.protocol}//")`
		};
	} catch (error) {
		return {
			ok: false,
			viaProxy: false,
			error: errorMessage(error)
		};
	}
	await ensureReady$1();
	let probeAgent;
	let viaProxy;
	let closeProbe = false;
	if (draft !== void 0) try {
		probeAgent = buildAgent(normalizeConfig({
			enabled: true,
			url: draft.url,
			...draft.username === void 0 || draft.username === "" ? {} : { username: draft.username },
			...draft.password === void 0 || draft.password === "" ? {} : { password: draft.password },
			bypass: []
		}));
		viaProxy = probeAgent !== void 0;
		closeProbe = true;
	} catch (error) {
		return {
			ok: false,
			viaProxy: false,
			error: errorMessage(error)
		};
	}
	else {
		viaProxy = current$1.enabled && agent !== void 0 && !matchesBypass(parsed.hostname, current$1.bypass);
		probeAgent = viaProxy ? agent : void 0;
	}
	const started = Date.now();
	try {
		const init = probeAgent !== void 0 ? {
			method: "GET",
			dispatcher: probeAgent,
			signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS)
		} : {
			method: "GET",
			signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS)
		};
		const response = probeAgent !== void 0 ? await dispatchFetch(parsed.toString(), init) : await fetch(parsed.toString(), init);
		response.arrayBuffer().catch(() => void 0);
		return {
			ok: true,
			viaProxy,
			status: response.status,
			latencyMs: Date.now() - started
		};
	} catch (error) {
		return {
			ok: false,
			viaProxy,
			latencyMs: Date.now() - started,
			error: describeFetchError(error)
		};
	} finally {
		if (closeProbe && probeAgent !== void 0) await probeAgent.close().catch(() => void 0);
	}
}

//#endregion
//#region src/auth/device-flow.ts
/** Default poll interval when the device-code response omits one. */
const DEFAULT_INTERVAL_SEC = 5;
/** Default device-code lifetime when the response omits one (GitHub: 15 minutes). */
const DEFAULT_EXPIRES_IN_SEC = 900;
/** Sleep for `ms`, rejecting early when the signal aborts. */
function sleep$1(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref();
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Own the set of in-flight device-flow attempts, keyed by provider. One
* attempt per provider at a time; an attempt removes itself when it settles.
*/
var DeviceFlowManager = class {
	attempts = /* @__PURE__ */ new Map();
	/**
	* Whether a device-flow attempt is running for one provider.
	* @param provider - the provider route.
	* @returns true while an attempt is polling.
	*/
	isBusy(provider) {
		return this.attempts.has(provider);
	}
	/**
	* The pending attempt for one provider, when any.
	* @param provider - the provider route.
	* @returns the in-flight attempt, or `undefined`.
	*/
	pending(provider) {
		return this.attempts.get(provider);
	}
	/**
	* Start a device-flow attempt: request a device code, then poll the token
	* endpoint in the background of `waitToken`.
	* @param provider - the provider route (one attempt at a time).
	* @param spec - static flow facts for this provider.
	* @returns the live attempt; its `waitToken()` settles the login.
	* @throws when an attempt is already running or the device-code request fails.
	*/
	async start(provider, spec) {
		if (this.attempts.has(provider)) throw new Error(`a ${provider} login attempt is already in progress`);
		const fetchFn = spec.fetchFn ?? proxiedFetch;
		const response = await fetchFn(spec.deviceCodeUrl, {
			method: "POST",
			headers: {
				"accept": "application/json",
				"content-type": "application/x-www-form-urlencoded"
			},
			body: new URLSearchParams({
				client_id: spec.clientId,
				scope: spec.scope
			}).toString()
		});
		if (!response.ok) throw new Error(`${provider} device-code request failed (HTTP ${String(response.status)})`);
		const wire = await response.json();
		if (typeof wire.device_code !== "string" || wire.device_code.length === 0 || typeof wire.user_code !== "string" || wire.user_code.length === 0 || typeof wire.verification_uri !== "string" || wire.verification_uri.length === 0) throw new Error(`${provider} device-code response is missing device_code/user_code/verification_uri`);
		const intervalSec = typeof wire.interval === "number" && wire.interval > 0 ? wire.interval : DEFAULT_INTERVAL_SEC;
		const expiresInSec = typeof wire.expires_in === "number" && wire.expires_in > 0 ? wire.expires_in : DEFAULT_EXPIRES_IN_SEC;
		const controller = new AbortController();
		let resolveToken;
		let rejectToken;
		const tokenPromise = new Promise((resolve, reject) => {
			resolveToken = resolve;
			rejectToken = reject;
		});
		tokenPromise.catch(() => void 0);
		const settle = (error, token) => {
			if (this.attempts.get(provider) !== attempt) return;
			this.attempts.delete(provider);
			if (error !== void 0) rejectToken(error);
			else if (token !== void 0) resolveToken(token);
		};
		const poll = async () => {
			let intervalMs = intervalSec * 1e3;
			const deadline = Date.now() + expiresInSec * 1e3;
			while (true) {
				await sleep$1(intervalMs, controller.signal);
				if (Date.now() >= deadline) {
					settle(/* @__PURE__ */ new Error(`login timed out after ${String(Math.round(expiresInSec))}s`));
					return;
				}
				const pollResponse = await fetchFn(spec.tokenUrl, {
					method: "POST",
					headers: {
						"accept": "application/json",
						"content-type": "application/x-www-form-urlencoded"
					},
					body: new URLSearchParams({
						client_id: spec.clientId,
						device_code: wire.device_code,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code"
					}).toString(),
					signal: controller.signal
				});
				const result = await pollResponse.json();
				if (typeof result.access_token === "string" && result.access_token.length > 0) {
					settle(void 0, result.access_token);
					return;
				}
				switch (result.error) {
					case "authorization_pending": break;
					case "slow_down":
						intervalMs += 5e3;
						break;
					case "access_denied":
						settle(/* @__PURE__ */ new Error("login declined on the GitHub authorization page"));
						return;
					case "expired_token":
						settle(/* @__PURE__ */ new Error("the device code expired before authorization completed"));
						return;
					default:
						settle(/* @__PURE__ */ new Error(`${provider} device-flow polling failed: ${result.error_description ?? result.error ?? `HTTP ${String(pollResponse.status)}`}`));
						return;
				}
			}
		};
		const attempt = {
			verificationUrl: wire.verification_uri,
			userCode: wire.user_code,
			waitToken: () => tokenPromise,
			cancel: () => {
				controller.abort(/* @__PURE__ */ new Error("login cancelled"));
				settle(/* @__PURE__ */ new Error("login cancelled"));
			}
		};
		this.attempts.set(provider, attempt);
		poll().catch((error) => {
			settle(error instanceof Error ? error : new Error(String(error)));
		});
		return attempt;
	}
};

//#endregion
//#region src/auth/claude-code-creds.ts
const PRIMARY_SERVICE = "Claude Code-credentials";
const DEFAULT_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";
function toSession(data) {
	if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string" || typeof data.expiresAt !== "number") return;
	const scopes = Array.isArray(data.scopes) ? data.scopes.join(" ") : typeof data.scopes === "string" ? data.scopes : DEFAULT_SCOPES;
	return {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: Math.trunc(data.expiresAt),
		scopes,
		...typeof data.emailAddress === "string" ? { emailAddress: data.emailAddress } : {},
		...typeof data.subscriptionType === "string" ? { subscriptionType: data.subscriptionType } : {}
	};
}
function parseBlob(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	return toSession(parsed.claudeAiOauth ?? parsed);
}
function credentialsFilePath() {
	return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
}
function readKeychainRaw() {
	try {
		return execFileSync("/usr/bin/security", [
			"find-generic-password",
			"-s",
			PRIMARY_SERVICE,
			"-w"
		], {
			timeout: 3e3,
			encoding: "utf8",
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
	} catch {
		return;
	}
}
function readFileRaw() {
	try {
		return readFileSync(credentialsFilePath(), "utf8");
	} catch {
		return;
	}
}
/** Read the current Claude Code session from its source of truth: macOS Keychain, falling back to the credentials file. */
function readClaudeCodeCredentials() {
	if (process.platform === "darwin") {
		const raw$1 = readKeychainRaw();
		const session = raw$1 !== void 0 ? parseBlob(raw$1) : void 0;
		if (session) return session;
	}
	const raw = readFileRaw();
	return raw !== void 0 ? parseBlob(raw) : void 0;
}
function blobMatches(raw, expectedAccessToken) {
	return parseBlob(raw)?.accessToken === expectedAccessToken;
}
function getKeychainAccountName() {
	try {
		const output = execFileSync("/usr/bin/security", [
			"find-generic-password",
			"-s",
			PRIMARY_SERVICE
		], {
			timeout: 2e3,
			encoding: "utf8",
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		return /"acct"<blob>="([^"]*)"/.exec(output)?.[1];
	} catch {
		return;
	}
}
/** Merge fresh tokens into an existing raw blob, preserving unrelated fields. */
function mergeIntoBlob(existingRaw, next) {
	let parsed;
	try {
		parsed = JSON.parse(existingRaw);
	} catch {
		return;
	}
	const target = parsed.claudeAiOauth ?? parsed;
	target.accessToken = next.accessToken;
	target.refreshToken = next.refreshToken;
	target.expiresAt = next.expiresAt;
	return JSON.stringify(parsed);
}
/**
* Write a refreshed session back to Claude Code's own credential store, so
* the `claude` CLI and any other consumer of the same account see the token
* we just rotated. A stale-blob mismatch (something else rotated it first)
* is a no-op — the caller already has that other rotation via readClaudeCodeCredentials.
* @param next - the freshly refreshed session to persist.
* @param expectedPriorAccessToken - the access token this refresh started from.
* @returns whether the write-back succeeded.
*/
function writeBackClaudeCodeCredentials(next, expectedPriorAccessToken) {
	if (process.platform === "darwin") {
		const raw$1 = readKeychainRaw();
		if (raw$1 === void 0 || !blobMatches(raw$1, expectedPriorAccessToken)) return false;
		const updated$1 = mergeIntoBlob(raw$1, next);
		if (updated$1 === void 0) return false;
		const account = getKeychainAccountName() ?? PRIMARY_SERVICE;
		try {
			execFileSync("/usr/bin/security", [
				"add-generic-password",
				"-s",
				PRIMARY_SERVICE,
				"-a",
				account,
				"-w",
				updated$1,
				"-U"
			], {
				timeout: 2e3,
				stdio: "ignore"
			});
			return true;
		} catch {
			return false;
		}
	}
	const path = credentialsFilePath();
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return false;
	}
	if (!blobMatches(raw, expectedPriorAccessToken)) return false;
	const updated = mergeIntoBlob(raw, next);
	if (updated === void 0) return false;
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		writeFileSync(path, updated, {
			encoding: "utf8",
			mode: 384
		});
		chmodSync(path, 384);
		return true;
	} catch {
		return false;
	}
}
/**
* Refresh a Claude session, first checking whether Claude Code's own store
* already holds a fresher token (rotated by the `claude` CLI or another
* consumer) before hitting the OAuth endpoint ourselves — and writing our own
* refresh back to that store so every consumer of the account stays synced.
* @param session - the session TokenManager wants refreshed.
* @param doRefresh - the actual OAuth refresh-token grant (network call).
* @returns the freshest available session.
*/
async function refreshClaudeSynced(session, doRefresh) {
	const fromSource = readClaudeCodeCredentials();
	const base = fromSource !== void 0 && fromSource.accessToken !== session.accessToken ? fromSource : session;
	if (base.expiresAt > Date.now() + 6e4) return base;
	const next = await doRefresh(base);
	writeBackClaudeCodeCredentials(next, base.accessToken);
	return next;
}

//#endregion
//#region src/auth/store.ts
/** Every provider route, in display order. */
const PROVIDER_IDS = [
	"codex",
	"claude",
	"grok",
	"copilot"
];
/**
* The stable identity of one session's account: codex keys on the always
* present `accountId` claim, the others on their display identity, falling
* back to a refresh-token hash for sessions stored before identity fields
* existed. Logging the same account in again lands on the same key, so a
* re-login updates in place instead of duplicating. (The hash fallback can
* miss that dedup once for a legacy session re-logged with a now-known
* identity — the duplicate is visible on the Settings page and can simply
* be logged out.)
* @param provider - the provider route.
* @param session - the session to key.
* @returns the account map key.
*/
function accountKeyOf(provider, session) {
	switch (provider) {
		case "codex": return session.accountId;
		case "claude": return session.emailAddress ?? tokenHash(session.refreshToken);
		case "grok": return session.account ?? tokenHash(session.refreshToken);
		case "copilot": return session.account ?? tokenHash(session.refreshToken);
	}
}
/** Short stable hash for sessions without an identity field. */
function tokenHash(refreshToken) {
	return `token-${createHash("sha256").update(refreshToken).digest("hex").slice(0, 16)}`;
}
/**
* Absolute path of the auth store file.
* @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
*/
function authFilePath() {
	return dshHomePath("plugins", "airules-subscriptions", "auth.json");
}
/** Check that one durable session carries the fields every session needs. */
function assertSessionShape(provider, account, value) {
	if (typeof value !== "object" || value === null) throw new Error(`subscriptions auth store: entry "${provider}/${account}" is not an object; fix or delete the store file`);
	const entry = value;
	if (entry.enabled !== void 0 && typeof entry.enabled !== "boolean") throw new Error(`subscriptions auth store: invalid enabled value for ${provider}/${account}`);
	if (entry.requiresLogin !== void 0 && typeof entry.requiresLogin !== "boolean") throw new Error(`subscriptions auth store: invalid requiresLogin value for ${provider}/${account}`);
	if (typeof entry.accessToken !== "string" || entry.accessToken.length === 0 || typeof entry.refreshToken !== "string" || entry.refreshToken.length === 0 || typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)) throw new Error(`subscriptions auth store: entry "${provider}/${account}" is missing accessToken/refreshToken/expiresAt; fix or delete the store file`);
}
/**
* Read the whole store. A missing file is an empty store; malformed JSON or a
* malformed entry throws, because silently discarding tokens would strand the
* user without a diagnosis. Single-account entries are migrated in memory;
* the next write persists the new shape.
* @param path - store file path; defaults to {@link authFilePath}.
* @returns the parsed session map.
*/
async function loadStore(path = authFilePath()) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return {};
	}
	return parseStore(text, path);
}
/** Parse, validate, and migrate store JSON read from `path`. */
function parseStore(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`);
	const raw = parsed;
	const store = {};
	for (const provider of PROVIDER_IDS) {
		const entry = raw[provider];
		if (entry === void 0) continue;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`subscriptions auth store: entry "${provider}" is not an object; fix or delete the store file`);
		const record = entry;
		if (typeof record.accessToken === "string") {
			assertSessionShape(provider, "(legacy)", record);
			const session = record;
			const key = accountKeyOf(provider, session);
			store[provider] = {
				default: key,
				accounts: { [key]: session }
			};
			continue;
		}
		const accounts = record.accounts;
		if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) throw new Error(`subscriptions auth store: entry "${provider}" has no accounts map; fix or delete the store file`);
		if (record.default !== void 0 && typeof record.default !== "string") throw new Error(`subscriptions auth store: entry "${provider}" default is not a string; fix or delete the store file`);
		for (const [account, session] of Object.entries(accounts)) assertSessionShape(provider, account, session);
		store[provider] = record;
	}
	return store;
}
/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store, path) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 384 });
		await chmod(tmp, 384);
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* One write chain per store path. Every mutation is a read-modify-write of a
* single JSON file, and the plugin has several independent writers — a login,
* a logout, and one token refresh per provider account, each on its own
* schedule. Overlapping them unserialized costs whichever account read the
* store first its entry.
*
* A chain is dropped once nothing is queued behind it, so the map holds an
* entry only while writes are in flight.
*/
const writeChains = /* @__PURE__ */ new Map();
/**
* Run one read-modify-write of a store path after every write already queued
* for it. Callers join the chain synchronously, so call order is write order.
* @param path - the store file being mutated.
* @param action - the read-modify-write to run.
* @returns whatever `action` returns.
*/
async function serialize(path, action) {
	const next = (writeChains.get(path) ?? Promise.resolve()).then(action, action);
	const tail = next.then(() => void 0, () => void 0);
	writeChains.set(path, tail);
	try {
		return await next;
	} finally {
		if (writeChains.get(path) === tail) writeChains.delete(path);
	}
}
/**
* List one provider's accounts, default first.
* @param provider - the provider route.
* @param path - store file path; defaults to {@link authFilePath}.
* @returns the account entries in stable order (empty when logged out).
*/
async function listAccounts(provider, path = authFilePath()) {
	const entry = (await loadStore(path))[provider];
	if (entry === void 0) return [];
	const accounts = Object.entries(entry.accounts).map(([key, session]) => ({
		key,
		session
	}));
	accounts.sort((a, b) => Number(b.key === entry.default) - Number(a.key === entry.default));
	return accounts;
}
/**
* Read one account's session.
* @param provider - the provider route.
* @param account - the account key; defaults to the provider's default account.
* @param path - store file path; defaults to {@link authFilePath}.
* @returns the stored session, or `undefined` when absent.
*/
async function getAccountSession(provider, account, path = authFilePath()) {
	const entry = (await loadStore(path))[provider];
	if (entry === void 0) return void 0;
	const key = account ?? entry.default;
	if (key === void 0) return void 0;
	return entry.accounts[key];
}
/**
* Write one account's session, preserving the others. The first account of a
* provider becomes its default.
* @param provider - the provider route.
* @param account - the account key (see {@link accountKeyOf}).
* @param session - the fresh session from a login or refresh.
* @param path - store file path; defaults to {@link authFilePath}.
*/
async function saveAccountSession(provider, account, session, path = authFilePath(), expectedAccessToken) {
	return serialize(path, async () => {
		const store = await loadStore(path);
		const entry = store[provider];
		// A refresh may finish after a manual login or logout. Compare inside the existing write queue.
		if (expectedAccessToken !== void 0 && entry?.accounts[account]?.accessToken !== expectedAccessToken) return entry?.accounts[account];
		store[provider] = {
			default: entry?.default ?? account,
			accounts: {
				...entry?.accounts,
				[account]: { ...session, ...(entry?.accounts[account]?.enabled === void 0 ? {} : { enabled: entry.accounts[account].enabled }) }
			}
		};
		await writeStore(store, path);
		return store[provider].accounts[account];
	});
}
/** Mark only the unchanged credential that was permanently rejected. */
async function markAccountRequiresLogin(provider, account, accessToken, path = authFilePath()) {
	return serialize(path, async () => {
		const store = await loadStore(path);
		const session = store[provider]?.accounts[account];
		if (session === void 0 || session.accessToken !== accessToken) return;
		session.requiresLogin = true;
		await writeStore(store, path);
	});
}
/**
* Delete one account's session (logout). Deleting the default moves the badge
* to the next remaining account.
* @param provider - the provider route.
* @param account - the account key.
* @param path - store file path; defaults to {@link authFilePath}.
*/
async function deleteAccountSession(provider, account, path = authFilePath()) {
	return serialize(path, async () => {
		const store = await loadStore(path);
		const entry = store[provider];
		if (entry === void 0 || !(account in entry.accounts)) return;
		const accounts = { ...entry.accounts };
		delete accounts[account];
		if (Object.keys(accounts).length === 0) delete store[provider];
		else store[provider] = {
			...entry.default === account ? { default: Object.keys(accounts)[0] } : { default: entry.default },
			accounts
		};
		await writeStore(store, path);
	});
}
/**
* Pin the account direct (non-pool) routes serve.
* @param provider - the provider route.
* @param account - the account key; must exist.
* @param path - store file path; defaults to {@link authFilePath}.
*/
async function setDefaultAccount(provider, account, path = authFilePath()) {
	return serialize(path, async () => {
		const store = await loadStore(path);
		const entry = store[provider];
		if (entry === void 0 || !(account in entry.accounts)) throw new Error(`no ${provider} account "${account}" is logged in`);
		store[provider] = {
			...entry,
			default: account
		};
		await writeStore(store, path);
	});
}

async function setAccountEnabled(provider, account, enabled, path = authFilePath()) {
	return serialize(path, async () => {
		const store = await loadStore(path);
		const entry = store[provider];
		if (!entry?.accounts[account]) throw new Error("Подписка не найдена; обновите список.");
		entry.accounts[account] = { ...entry.accounts[account], enabled };
		await writeStore(store, path);
	});
}

//#endregion
//#region src/auth/rpc.ts
/** The RPC channel this plugin registers on the host connection. */
const SUBSCRIPTIONS_AUTH_CHANNEL = "/airules-subscriptions-auth";
/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/;
/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
var BadRequest = class extends Error {};
function ok(value) {
	return {
		ok: true,
		value
	};
}
function failure(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof BadRequest) return {
		ok: false,
		error: {
			code: "bad-request",
			message,
			details: { issues: [] }
		}
	};
	return {
		ok: false,
		error: {
			code: "internal",
			message,
			details: {}
		}
	};
}
function readProvider(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const provider = payload.provider;
	if (typeof provider !== "string" || !PROVIDER_IDS.includes(provider)) throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(", ")}`);
	return provider;
}
function readString(payload, field) {
	const value = payload[field];
	if (typeof value !== "string" || value.length === 0) throw new BadRequest(`payload.${field} must be a non-empty string`);
	return value;
}
/** Validate the `setModelDefault` endpoint's payload. */
function readModelDefaultInput(payload) {
	const provider = readProvider(payload);
	const model = readString(payload, "model");
	const record = payload;
	let effort;
	if (record.effort !== void 0) {
		if (typeof record.effort !== "string" || record.effort.length === 0) throw new BadRequest("payload.effort must be a non-empty string when present");
		effort = record.effort;
	}
	return {
		provider,
		model,
		...effort === void 0 ? {} : { effort }
	};
}
/** Validate the optional Claude login method. */
function readLoginMethod(payload, provider) {
	const method = payload.method;
	if (method === void 0) return void 0;
	if (provider !== "claude") throw new BadRequest("payload.method is only valid for claude");
	if (method !== "oauth" && method !== "keychain") throw new BadRequest("payload.method must be \"oauth\" or \"keychain\"");
	return method;
}
/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload) {
	const tier = payload.tier;
	if (tier !== "standard" && tier !== "fast") throw new BadRequest("payload.tier must be \"standard\" or \"fast\"");
	return tier;
}
/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const record = payload;
	const attachmentId = record.attachmentId;
	if (typeof attachmentId !== "string" || attachmentId.length === 0) throw new BadRequest("payload.attachmentId must be a non-empty string");
	const mediaType = record.mediaType;
	if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.includes(mediaType)) throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(", ")}`);
	for (const field of [
		"bytes",
		"width",
		"height"
	]) {
		const value = record[field];
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new BadRequest(`payload.${field} must be a positive integer`);
	}
	const name$1 = record.name;
	if (name$1 !== void 0 && typeof name$1 !== "string") throw new BadRequest("payload.name must be a string when present");
	return {
		attachmentId: AttachmentId(attachmentId),
		mediaType,
		bytes: record.bytes,
		width: record.width,
		height: record.height,
		...name$1 === void 0 ? {} : { name: name$1 }
	};
}
/**
* Validate the `video` endpoint's payload into a bare file name. Rejecting
* anything with a path separator (the pattern allows none) pins every read
* inside the plugin's videos directory.
*/
function readVideoName(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const name$1 = payload.name;
	if (typeof name$1 !== "string" || !VIDEO_NAME_PATTERN.test(name$1)) throw new BadRequest("payload.name must be a bare .mp4 file name");
	return name$1;
}
/** Validate the usage/model catalog endpoints' optional force flag. */
function readForce(payload) {
	if (typeof payload !== "object" || payload === null) return false;
	const force = payload.force;
	if (force === void 0) return false;
	if (typeof force !== "boolean") throw new BadRequest("payload.force must be a boolean when present");
	return force;
}
/** Validate the session id both speed endpoints carry. */
function readSessionId(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	return readString(payload, "sessionId");
}
/** Validate a `proxySet` payload into a shape `ProxyInput` accepts. */
function readProxyInput(payload) {
	if (typeof payload !== "object" || payload === null) throw new BadRequest("payload must be an object");
	const record = payload;
	if (typeof record.enabled !== "boolean") throw new BadRequest("payload.enabled must be a boolean");
	if (typeof record.url !== "string") throw new BadRequest("payload.url must be a string");
	let username;
	if (record.username !== void 0) {
		if (typeof record.username !== "string") throw new BadRequest("payload.username must be a string when present");
		username = record.username;
	}
	let password;
	if (record.password !== void 0) {
		if (record.password !== null && typeof record.password !== "string") throw new BadRequest("payload.password must be a string or null when present");
		password = record.password;
	}
	let bypass;
	if (record.bypass !== void 0) {
		if (!Array.isArray(record.bypass) || record.bypass.some((entry) => typeof entry !== "string")) throw new BadRequest("payload.bypass must be an array of strings when present");
		bypass = record.bypass;
	}
	return {
		enabled: record.enabled,
		url: record.url,
		...username === void 0 ? {} : { username },
		...password === void 0 ? {} : { password },
		...bypass === void 0 ? {} : { bypass }
	};
}
/** Validate a `proxyTest` payload (the destination URL and an optional draft). */
function readProxyTestPayload(payload) {
	if (typeof payload !== "object" || payload === null) return {};
	const record = payload;
	const url = record.url;
	if (url === void 0 && record.proxy === void 0) return {};
	if (url !== void 0 && (typeof url !== "string" || url.length === 0)) throw new BadRequest("payload.url must be a non-empty string when present");
	let proxy;
	if (record.proxy !== void 0) {
		if (typeof record.proxy !== "object" || record.proxy === null) throw new BadRequest("payload.proxy must be an object when present");
		const draftRecord = record.proxy;
		if (typeof draftRecord.url !== "string" || draftRecord.url.length === 0) throw new BadRequest("payload.proxy.url must be a non-empty string");
		let username;
		if (draftRecord.username !== void 0) {
			if (typeof draftRecord.username !== "string") throw new BadRequest("payload.proxy.username must be a string when present");
			username = draftRecord.username;
		}
		let password;
		if (draftRecord.password !== void 0) {
			if (typeof draftRecord.password !== "string") throw new BadRequest("payload.proxy.password must be a string when present");
			password = draftRecord.password;
		}
		proxy = {
			url: draftRecord.url,
			...username === void 0 ? {} : { username },
			...password === void 0 ? {} : { password }
		};
	}
	return {
		...url === void 0 ? {} : { url },
		...proxy === void 0 ? {} : { proxy }
	};
}
async function dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal, providerSettings) {
	switch (endpoint) {
		case "providerSettings":
			if (!providerSettings) throw new BadRequest("provider settings are unavailable");
			return ok(await providerSettings.get(readProvider(payload), readForce(payload)));
		case "setProviderSettings": {
			if (!providerSettings) throw new BadRequest("provider settings are unavailable");
			const provider = readProvider(payload);
			return ok({ ok: true, ...await providerSettings.set(provider, payload.settings) });
		}
		case "status": {
			const entries = await Promise.all(PROVIDER_IDS.map(async (provider) => [provider, await controller.status(provider)]));
			return ok({ providers: Object.fromEntries(entries) });
		}
		case "login": {
			const provider = readProvider(payload);
			const account = payload.account === void 0 ? void 0 : readString(payload, "account");
			if (account !== void 0 && provider !== "codex") throw new BadRequest("targeted login is only available for codex");
			return ok(await controller.login(provider, readLoginMethod(payload, provider), account));
		}
		case "manual": {
			const provider = readProvider(payload);
			await controller.manual(provider, readString(payload, "input"));
			return ok({ ok: true });
		}
		case "cancel":
			await controller.cancel(readProvider(payload));
			return ok({ ok: true });
		case "logout": {
			const provider = readProvider(payload);
			await controller.logout(provider, readString(payload, "account"));
			return ok({ ok: true });
		}
		case "setDefault": {
			const provider = readProvider(payload);
			await controller.setDefault(provider, readString(payload, "account"));
			return ok({ ok: true });
		}
		case "setEnabled": {
			const provider = readProvider(payload);
			if (provider !== "codex" || typeof payload.enabled !== "boolean") throw new BadRequest("Укажите Codex-подписку и enabled true/false.");
			await controller.setEnabled(provider, readString(payload, "account"), payload.enabled);
			return ok({ ok: true });
		}
		case "usage": {
			const provider = readProvider(payload);
			return ok(await controller.usage(provider, readString(payload, "account"), signal, readForce(payload)));
		}
		case "modelUsage":
			return ok(await speed.modelUsage(readSessionId(payload), readString(payload, "provider"), readString(payload, "model"), signal));
		case "image": return ok(await controller.readImage(readImageRef(payload), signal));
		case "video": return ok(await controller.readVideo(readVideoName(payload), signal));
		case "speed": return ok(await speed.speed(readSessionId(payload)));
		case "setSpeed":
			await speed.setSpeed(readSessionId(payload), readSpeedTier(payload));
			return ok({ ok: true });
		case "proxyGet":
			if (proxy === void 0) throw new BadRequest("proxy configuration is unavailable");
			return ok(await proxy.get());
		case "proxySet":
			if (proxy === void 0) throw new BadRequest("proxy configuration is unavailable");
			return ok(await proxy.set(readProxyInput(payload)));
		case "proxyTest":
			if (proxy === void 0) throw new BadRequest("proxy configuration is unavailable");
			return ok(await proxy.test(readProxyTestPayload(payload)));
		case "modelDefaults":
			if (modelDefaults === void 0) throw new BadRequest("model defaults are unavailable");
			return ok(await modelDefaults.catalog(readForce(payload)));
		case "setModelDefault":
			if (modelDefaults === void 0) throw new BadRequest("model defaults are unavailable");
			{
				const input = readModelDefaultInput(payload);
				await modelDefaults.set(input.provider, input.model, input.effort);
			}
			return ok({ ok: true });
		default: throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`);
	}
}
/**
* Register the `/subscriptions-auth` RPC channel when a host connection exists.
* @param ctx - the plugin context (headless profiles have no `connection`).
* @param controller - the auth operations backing the endpoints.
* @param speed - the per-session speed-tier state backing the Speed toggle.
* @param proxy - optional proxy-config controller backing `proxyGet`/`proxySet`/`proxyTest`.
* @param modelDefaults - optional per-model default-effort state backing `modelDefaults`/`setModelDefault`.
*/
function registerAuthRpc(ctx, controller, speed, proxy = void 0, modelDefaults = void 0, providerSettings = void 0) {
	// Native rpc.handle binds its route to this scope and reads owner.webServer.
	// Declare both services or the optional fiber fails while the parent stays active.
	ctx.inject(["connection", "webServer"], (ctx$1) => {
		const connection = ctx$1.connection;
		// rc.5 rpc getter shadows the provider context; pass the declared route
		// owner explicitly so native registration retains webServer admission/lifetime.
		ctx$1.effect(() => connection.register(ctx$1, SUBSCRIPTIONS_AUTH_CHANNEL, async (endpoint, payload, signal) => {
			try {
				return await dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal, providerSettings);
			} catch (error) {
				return failure(error);
			}
		}), "airules: subscription RPC channel");
	});
}

//#endregion
//#region src/model-defaults.ts
/** Absolute path of the defaults file. */
function modelDefaultsFilePath() {
	return dshHomePath("plugins", "airules-subscriptions", "model-defaults.json");
}
const EMPTY = Object.freeze({});
/** In-memory snapshot read by every consumer (adapters, RPC). */
let current = EMPTY;
/** One lazy load of the on-disk file (read once per process). */
let ready;
/** Last load failure, surfaced to callers that care; defaults stay empty. */
let loadError;
/**
* Serialises every write: the read-modify-write sequence must not interleave,
* or a fast second save would compute its snapshot from the stale `current`
* and silently drop the first update (the UI disables only the row being
* saved, so overlaps are reachable).
*/
let writeChain = Promise.resolve();
/**
* Validate one persisted provider section: a string→string map, or undefined.
* Malformed *entries* are skipped, not the whole section: one bad value (a
* hand edit losing its quotes) must not silently un-configure every model in
* that provider. What was dropped is reported so the caller can surface it
* instead of the loss disappearing.
*/
function sanitizeProvider(value, dropped) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const entries = {};
	for (const [model, effort] of Object.entries(value)) {
		if (typeof effort !== "string" || effort.length === 0) {
			dropped.push(model);
			continue;
		}
		entries[model] = effort;
	}
	if (Object.keys(entries).length === 0) return void 0;
	return Object.freeze(entries);
}
/** Validate the raw document: only known providers, malformed sections dropped. */
function sanitizeDefaults(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {
		defaults: EMPTY,
		dropped: []
	};
	const record = value;
	const result = {};
	const dropped = [];
	for (const provider of PROVIDER_IDS) {
		const section = sanitizeProvider(record[provider], dropped);
		if (section !== void 0) result[provider] = section;
	}
	return {
		defaults: Object.freeze(result),
		dropped
	};
}
/** Read and validate the on-disk file; a missing file reads as empty. */
async function loadFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return EMPTY;
		throw error;
	}
	try {
		const { defaults, dropped } = sanitizeDefaults(JSON.parse(text));
		if (dropped.length > 0) loadError = /* @__PURE__ */ new Error(`subscriptions model defaults: ${dropped.length} malformed entr${dropped.length === 1 ? "y" : "ies"} skipped (${dropped.join(", ")}); fix or delete the file`);
		return defaults;
	} catch {
		throw new Error(`subscriptions model defaults at ${path} are not valid JSON; fix or delete the file`);
	}
}
/** Resolve the module state once from disk; failures leave the defaults empty. */
async function ensureReady() {
	ready ??= loadFile(modelDefaultsFilePath()).then((loaded) => {
		current = loaded;
	}, (error) => {
		loadError = error;
		current = EMPTY;
	});
	return ready;
}
/** Persist a snapshot atomically with owner-only permissions. */
async function atomicPersist(defaults, path) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(defaults, null, 2), { mode: 384 });
		await chmod(tmp, 384);
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
let persistDefaults = atomicPersist;
/**
* Clone one provider section, or undefined when nothing is configured for it.
* The clone is prototype-less: model ids are provider-supplied catalog data
* used as object keys, and consumers index the section directly (the RPC
* catalog in index.ts does), so an id like `toString` would otherwise yield an
* inherited *function* where a string is declared.
*/
function sectionOf(defaults, provider) {
	const section = defaults[provider];
	if (section === void 0) return void 0;
	return Object.assign(Object.create(null), section);
}
/**
* Ready the defaults store.
* @internal Exported for tests; index.ts calls it at apply time so every
* later synchronous read sees the persisted state.
*/
async function loadModelDefaults() {
	await ensureReady();
}
/**
* The configured default effort for one model, or undefined when none (the
* picker then follows the provider's own default).
* @internal Exported for the adapters' `defaultEffortOf` options.
*/
function defaultEffortOf(provider, model) {
	const section = current[provider];
	if (section === void 0) return void 0;
	return Object.prototype.hasOwnProperty.call(section, model) ? section[model] : void 0;
}
/**
* Set or clear one model's configured default effort, then persist. The
* memory snapshot updates only after the atomic write succeeds, so a failed
* write never leaves the live state ahead of the file.
* @param provider - the subscription provider route.
* @param model - the wire model id.
* @param effort - the effort id, or undefined to clear the override.
*/
function setDefaultEffort(provider, model, effort) {
	const run = writeChain.then(async () => {
		await ensureReady();
		const section = { ...sectionOf(current, provider) ?? {} };
		if (effort === void 0) delete section[model];
		else section[model] = effort;
		const next = { ...current };
		if (Object.keys(section).length === 0) delete next[provider];
		else next[provider] = Object.freeze(section);
		const frozen = Object.freeze(next);
		await persistDefaults(frozen, modelDefaultsFilePath());
		current = frozen;
	});
	writeChain = run.catch(() => void 0);
	return run;
}

//#endregion
//#region src/providers/rate-limit.ts
/**
* Extra time added to every provider-disclosed wait. Absorbs clock skew
* between the harness and the provider, so a retry does not land a moment
* before the window actually reopens and burn an attempt on a second 429.
*/
const RESET_GRACE_MS = 2e3;
/** Shortest wait ever scheduled, including for a reset instant already in the past. */
const MIN_WAIT_MS = 1e3;
/** Below this a bare number is a delay in seconds rather than an epoch stamp. */
const EPOCH_SECONDS_FLOOR = 1e9;
/** At or above this a bare epoch stamp is already in milliseconds. */
const EPOCH_MILLIS_FLOOR = 0xe8d4a51000;
/** Node's maximum timer delay; a longer wait cannot be scheduled at all. */
const MAX_TIMER_DELAY_MS = 2147483647;
/** Default ceiling on a rate-limit wait: six hours covers a five-hour session window with slack. */
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 360 * 60 * 1e3;
/**
* Interpret a bare numeric rate-limit value, which providers write in three
* shapes: epoch milliseconds, epoch seconds, or a delay in seconds. The
* magnitude separates them unambiguously for any plausible value — an epoch in
* seconds is ~1.8e9 today, while a delay of even a full week is ~6e5.
* @param value - the raw numeric value.
* @param now - the current epoch milliseconds.
* @returns epoch milliseconds of the reset, or undefined when the value is unusable.
*/
function resetInstantFromNumber(value, now) {
	if (!Number.isFinite(value) || value <= 0) return void 0;
	if (value >= EPOCH_MILLIS_FLOOR) return value;
	if (value >= EPOCH_SECONDS_FLOOR) return value * 1e3;
	return now + value * 1e3;
}
/**
* Parse a Go-style duration (`6m0s`, `1h2m3.5s`, `150ms`) into milliseconds —
* the form OpenAI-compatible `x-ratelimit-reset-*` headers use.
* @param text - the raw header value.
* @returns the duration in milliseconds, or undefined when the text is not one.
*/
function durationMs(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return void 0;
	const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/y;
	const units = {
		h: 36e5,
		m: 6e4,
		s: 1e3,
		ms: 1
	};
	let total = 0;
	let matched = false;
	let index = 0;
	let previousUnit = Number.POSITIVE_INFINITY;
	for (;;) {
		pattern.lastIndex = index;
		const match = pattern.exec(trimmed);
		if (match === null) break;
		const unit = units[match[2]];
		if (unit >= previousUnit) return void 0;
		previousUnit = unit;
		total += Number(match[1]) * unit;
		index = pattern.lastIndex;
		matched = true;
	}
	if (!matched || index !== trimmed.length) return void 0;
	return total > 0 ? total : void 0;
}
/**
* Interpret any single rate-limit value — a number, a numeric string, a
* duration (`6m0s`), or a date — as the instant a window reopens. One reader
* for every shape, so a provider that changes the encoding of a field it
* already sends does not need a code change here.
* @param value - the raw header value or JSON field.
* @param now - the current epoch milliseconds.
* @returns epoch milliseconds of the reset, or undefined when the value is unusable.
*/
function resetInstantFromValue(value, now) {
	if (typeof value === "number") return resetInstantFromNumber(value, now);
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed.length === 0) return void 0;
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) return resetInstantFromNumber(numeric, now);
	const duration = durationMs(trimmed);
	if (duration !== void 0) return now + duration;
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Read a header carrying any of the {@link resetInstantFromValue} shapes.
* @param response - the failed response.
* @param name - the header to read.
* @param now - the current epoch milliseconds.
* @returns epoch milliseconds of the reset, or undefined when absent or unusable.
*/
function resetInstantFromHeader(response, name$1, now) {
	return resetInstantFromValue(response.headers.get(name$1), now);
}
/**
* Read the RFC 7231 `retry-after` header in both its forms: a delay in seconds
* (never an epoch stamp, whatever its magnitude) or an HTTP-date.
* @param response - the failed response.
* @param now - the current epoch milliseconds.
* @returns epoch milliseconds of the reset, or undefined when absent or unusable.
*/
function retryAfterInstant(response, now) {
	const raw = response.headers.get("retry-after");
	if (raw === null) return void 0;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return void 0;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) return seconds > 0 ? now + seconds * 1e3 : void 0;
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Parse a response body as JSON without throwing on the non-JSON bodies
* providers occasionally return under load (an HTML gateway page, say).
* @param body - the complete response body.
* @returns the parsed value, or undefined when the body is not JSON.
*/
function jsonBody(body) {
	if (body.length === 0) return void 0;
	try {
		return JSON.parse(body);
	} catch {
		return;
	}
}
/** How deep {@link resetFromFields} walks; every observed payload nests one or two levels. */
const MAX_BODY_DEPTH = 4;
/**
* Find a reset instant under any of the named keys, anywhere in a parsed body.
*
* The search is by key rather than by path on purpose: providers move the same
* field between containers (`detail`, `error`, top level) across endpoints and
* versions, and a path-shaped reader silently stops working when they do. Only
* the key list is provider-specific.
* @param value - the parsed body, or any nested value.
* @param keys - field names this provider uses for a reset or delay.
* @param now - the current epoch milliseconds.
* @param depth - remaining recursion depth.
* @returns the earliest instant found, or undefined when no key matched.
*/
function resetFromFields(value, keys, now, depth = MAX_BODY_DEPTH) {
	if (depth <= 0 || value === null || typeof value !== "object") return void 0;
	let earliest;
	const consider = (candidate) => {
		if (candidate !== void 0 && (earliest === void 0 || candidate < earliest)) earliest = candidate;
	};
	if (Array.isArray(value)) {
		for (const item of value) consider(resetFromFields(item, keys, now, depth - 1));
		return earliest;
	}
	for (const [key, nested] of Object.entries(value)) if (keys.includes(key)) consider(resetInstantFromValue(nested, now));
	else consider(resetFromFields(nested, keys, now, depth - 1));
	return earliest;
}
/**
* The earliest of several candidate reset instants, ignoring absent ones. The
* earliest is the one that matters: it is the first moment any of the reported
* limits allows a request again.
* @param candidates - reset instants in no particular order.
* @returns the earliest instant, or undefined when every candidate is absent.
*/
function earliestReset(...candidates) {
	let earliest;
	for (const candidate of candidates) {
		if (candidate === void 0) continue;
		if (earliest === void 0 || candidate < earliest) earliest = candidate;
	}
	return earliest;
}
/**
* Turn a reset instant into the wait to report as `providerRetryAfterMs`.
*
* Deliberately not capped: a reset beyond the policy's `maxDelayMs` makes the
* retry plugin delegate immediately, failing the turn at once with the real
* reset in the message, rather than clamping the wait down and burning the
* retry budget against a window that is still closed.
* @param instant - epoch milliseconds the window reopens.
* @param now - the current epoch milliseconds.
* @returns the wait in milliseconds, never below {@link MIN_WAIT_MS}.
*/
function waitFromReset(instant, now) {
	return Math.max(MIN_WAIT_MS, instant - now + RESET_GRACE_MS);
}
/** Header names worth showing when a 429 disclosed no reset this code recognizes. */
const DIAGNOSTIC_HEADER = /rate-?limit|retry|reset|^x-codex-/i;
/**
* Render the rate-limit-shaped headers and the head of the body of a 429 whose
* reset instant nothing parsed. Emitted through the adapter's `onWarn`, this is
* how an unrecognized provider field gets named from live traffic instead of
* being guessed at.
*
* It is also where the per-bucket rollover snapshots land by design — no reader
* parks a turn on one, because on a 429 they cannot say which bucket refused —
* so the operator still sees what the provider disclosed.
* @param response - the failed response.
* @param body - the complete response body.
* @returns a one-line diagnostic.
*/
function rateLimitDiagnostics(response, body) {
	const headers = [];
	response.headers.forEach((value, key) => {
		if (DIAGNOSTIC_HEADER.test(key)) headers.push(`${key}: ${value}`);
	});
	headers.sort();
	const rendered = headers.length > 0 ? headers.join("; ") : "(none)";
	const head = body.slice(0, 200);
	return `429 disclosed no reset time; headers [${rendered}]; body ${head.length > 0 ? head : "(empty)"}`;
}
/**
* The retry shape every subscription route starts from: Claude Code's own SDK
* numbers — ten retries after the first attempt, exponential backoff from 1s
* doubling per attempt, capped at 60s, plus 20% jitter.
*
* Shared across all four routes rather than kept to claude, because what these
* numbers are tuned for is the shape of a subscription endpoint — a consumer
* plan behind a session window, which sheds load in bursts and rewards an
* attempt that outlasts them — and that is the same on all four. The dsh-llm
* defaults (5 retries from 500ms to 10s) give up after about fifteen seconds,
* which is short for that.
*
* The 60s cap governs local backoff only: a disclosed rate-limit reset is
* accepted up to the configured wait ceiling instead.
*/
const DEFAULT_RETRY = Object.freeze({
	maxRetries: 10,
	initialDelayMs: 1e3,
	maxDelayMs: 6e4,
	jitterRatio: .2
});
/** Waiting behavior a route falls back to when the plugin passed none (waiting on, six-hour ceiling). */
const DEFAULT_RATE_LIMIT_WAIT = Object.freeze({
	wait: true,
	maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS
});
/**
* Validate and default the rate-limit waiting config.
* @param config - the raw plugin config section, when present.
* @param path - diagnostic path naming the config that owns the value.
* @returns the resolved, immutable behavior.
*/
function resolveRateLimitWait(config, path) {
	const wait = config?.wait ?? true;
	const maxWaitMs = config?.maxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
	if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new Error(`${path}.maxWaitMs must be a positive finite number of milliseconds`);
	if (maxWaitMs > MAX_TIMER_DELAY_MS) throw new Error(`${path}.maxWaitMs must be no greater than ${String(MAX_TIMER_DELAY_MS)} (the maximum schedulable delay)`);
	return Object.freeze({
		wait,
		maxWaitMs
	});
}
/**
* Resolve one route's retry policy, widening the delay ceiling to the
* configured wait so a disclosed reset hours out is accepted rather than
* refused.
*
* The ceiling is shared with local exponential backoff, so widening it also
* raises how long an unrelated transient failure may back off for. That stays
* bounded by the finite retry budget — the claude route's ten retries reach
* 512 s per attempt at most — and it only governs when the provider disclosed
* nothing, which is exactly the case where a longer wait is the safer guess.
* @param defaults - the route's retry shape.
* @param rateLimit - resolved waiting behavior.
* @param path - diagnostic path naming the provider route.
* @returns the policy to report from `providerRetryPolicy`.
*/
function subscriptionRetryPolicy(defaults, rateLimit, path) {
	const maxDelayMs = rateLimit.wait ? Math.max(defaults.maxDelayMs, rateLimit.maxWaitMs) : defaults.maxDelayMs;
	return resolveRetryPolicy({
		mode: "normal",
		maxRetries: defaults.maxRetries,
		backoff: {
			initialDelayMs: defaults.initialDelayMs,
			maxDelayMs,
			jitterRatio: defaults.jitterRatio
		}
	}, path);
}

//#endregion
//#region src/providers/common.ts
/**
* Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
* @param models - raw configured entries.
* @param label - diagnostic prefix naming the provider.
* @returns the validated entries.
*/
function validateModels(models, label) {
	const seen = /* @__PURE__ */ new Set();
	return models.map((model) => {
		if (model.id.length === 0) throw new Error(`${label}: catalog model ids must be non-empty`);
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`${label}: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (model.inputModalities !== void 0 && (model.inputModalities.length === 0 || model.inputModalities.some((modality) => modality !== "text" && modality !== "image"))) throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`);
		if (model.wire !== void 0 && model.wire !== "chat-completions" && model.wire !== "responses") throw new Error(`${label}: catalog model "${model.id}" wire must be "chat-completions" or "responses"`);
		if (seen.has(model.id)) throw new Error(`${label}: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] },
			...model.wire === void 0 ? {} : { wire: model.wire }
		};
	});
}
/**
* Build an LlmError from a non-2xx provider response, mapping the status to a
* stable code and, for a rate-limited request, the disclosed reset instant to
* the `providerRetryAfterMs` the retry plugin waits out.
*
* A 429 classifies as `RATE_LIMIT` on the strength of the status alone, ahead
* of the quota-wording check. On these routes there is no terminal quota to
* distinguish: a subscription has no balance to top up, only a window that
* reopens, and providers announce an exhausted window with wording
* (`usage_limit_reached`) the shared classifier reads as permanent.
* @param response - the failed response.
* @param label - diagnostic prefix naming the provider API.
* @param options - the calling provider's rate-limit reader and warning sink.
* @returns the classified error.
*/
async function httpLlmError(response, label, options = {}) {
	let body = "";
	try {
		body = await response.text();
	} catch {}
	const shown = body.slice(0, 500);
	const message = shown.length > 0 ? `${label} error (HTTP ${String(response.status)}): ${shown}` : `${label} error (HTTP ${String(response.status)})`;
	let code;
	if (response.status === 401 || response.status === 403) code = "AUTH";
	else if (response.status === 429) code = "RATE_LIMIT";
	else if (isQuotaExceededError(shown)) code = QUOTA_EXCEEDED_CODE;
	else if (response.status === 400 && isContextWindowExceededError(shown)) code = CONTEXT_WINDOW_EXCEEDED_CODE;
	else if (response.status === 408 || response.status === 504) code = "TIMEOUT";
	else if (response.status >= 500) code = "SERVER";
	else code = `HTTP_${String(response.status)}`;
	const now = Date.now();
	const rateLimited = response.status === 429;
	const reset = rateLimited ? options.rateLimitReset?.(response, body, now) ?? retryAfterInstant(response, now) : retryAfterInstant(response, now);
	if (reset === void 0 && rateLimited) options.onWarn?.(`${label}: ${rateLimitDiagnostics(response, body)}`);
	return new LlmError(message, code, {
		status: response.status,
		...reset === void 0 ? {} : { providerRetryAfterMs: waitFromReset(reset, now) }
	});
}
/**
* Parse a response's `retry-after` header (seconds) into milliseconds.
* @param response - the failed response.
* @returns the delay in ms, or undefined when absent/unusable.
*/
function parseRetryAfterMs(response) {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter === null) return void 0;
	const seconds = Number(retryAfter);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : void 0;
}
/**
* Create an idle watchdog chained to the caller's signal.
* @param caller - the request's own abort signal, when present.
* @param timeoutMs - maximum idle interval while a stream read is outstanding.
* @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
*/
function idleWatchdog(caller, timeoutMs) {
	const controller = new AbortController();
	let expired = false;
	let timer;
	const arm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			expired = true;
			controller.abort(/* @__PURE__ */ new Error(`stream idle timeout after ${String(timeoutMs)}ms`));
		}, timeoutMs);
		timer.unref();
	};
	const onCallerAbort = () => controller.abort(caller?.reason);
	if (caller?.aborted === true) controller.abort(caller.reason);
	else caller?.addEventListener("abort", onCallerAbort, { once: true });
	arm();
	return {
		signal: controller.signal,
		pulse: arm,
		stop() {
			if (timer !== void 0) clearTimeout(timer);
			caller?.removeEventListener("abort", onCallerAbort);
		},
		timedOut: () => expired
	};
}
/**
* Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
* expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
* TRANSPORT with the cause chained.
* @param label - diagnostic prefix naming the provider API.
* @param error - the thrown value.
* @param watchdog - the request's idle watchdog.
* @param caller - the request's own abort signal, when present.
* @returns the classified error.
*/
function mapFetchFailure(label, error, watchdog, caller) {
	if (watchdog.timedOut()) return new LlmError(`${label} stream idle timeout`, "TIMEOUT", { cause: error });
	if (caller?.aborted === true) return new LlmError(`${label} request aborted by caller`, "ABORTED", { cause: error });
	if (error instanceof LlmError) return error;
	return new LlmError(`${label} request failed`, "TRANSPORT", { cause: error });
}
/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
var OAuthEndpointError = class extends Error {
	/** HTTP status of the token endpoint response. */
	status;
	/** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
	oauthCode;
	/**
	* The endpoint's `retry-after`, in ms, when it sent one. Usage/models
	* endpoints reuse this error type and can rate-limit progressively (each
	* hit within the window extends the next one), so a caller retrying on a
	* fixed schedule instead of honoring this can keep an account locked out
	* indefinitely.
	*/
	retryAfterMs;
	constructor(message, status, oauthCode, retryAfterMs$1) {
		super(message);
		this.name = "OAuthEndpointError";
		this.status = status;
		this.oauthCode = oauthCode;
		this.retryAfterMs = retryAfterMs$1;
	}
};
/**
* Read an OAuth JSON error body into an {@link OAuthEndpointError}.
* @param response - the failed token-endpoint response.
* @param label - diagnostic prefix naming the provider.
* @returns the error to throw.
*/
async function oauthEndpointError(response, label) {
	let oauthCode;
	let detail = "";
	try {
		const parsed = await response.json();
		oauthCode = typeof parsed.error === "string" ? parsed.error : void 0;
		detail = typeof parsed.error_description === "string" ? parsed.error_description : oauthCode ?? "";
	} catch {}
	return new OAuthEndpointError(detail.length > 0 ? `${label} token endpoint error (HTTP ${String(response.status)}): ${detail}` : `${label} token endpoint error (HTTP ${String(response.status)})`, response.status, oauthCode, parseRetryAfterMs(response));
}
/**
* Per-provider session freshness: loads the stored session, refreshes
* proactively inside the preempt window or on demand after a 401, and
* coalesces concurrent refreshes behind one in-flight promise. Permanent
* refresh failures delete the stored session and surface INVALID_CREDENTIAL
* with a re-login hint; transient failures fall back to a still-valid token.
*/
var TokenManager = class {
	inflight;
	constructor(options) {
		this.options = options;
		this.options = options;
	}
	/**
	* Read the stored session without any refresh side effect. Catalog queries
	* (`listModels`) use this to decide whether the provider is logged in.
	* @returns the stored session, or `undefined` when logged out.
	*/
	peek() {
		return this.options.load();
	}
	/**
	* Whether a session is currently stored (cheap; never refreshes).
	* @returns true when logged in.
	*/
	async hasSession() {
		return await this.options.load() !== void 0;
	}
	/**
	* Resolve a usable session, refreshing proactively or on demand.
	* @param forceRefresh - refresh regardless of expiry (used after a 401).
	* @returns the persisted session to send.
	* @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
	*   when the refresh grant is permanently rejected.
	*/
	async session(forceRefresh = false, rejectedAccessToken) {
		const session = await this.options.load();
		if (session === void 0) throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions in the dsh web app`, "MISSING_CREDENTIAL");
		if (session.requiresLogin === true) throw new LlmError("Доступ к подписке истёк. Нажмите «Войти заново» в её карточке.", "INVALID_CREDENTIAL");
		if (forceRefresh && rejectedAccessToken !== void 0 && session.accessToken !== rejectedAccessToken && session.expiresAt - Date.now() > this.options.preemptMs) return session;
		if (!forceRefresh && session.expiresAt - Date.now() > this.options.preemptMs) return session;
		this.inflight ??= this.doRefresh(session).finally(() => {
			this.inflight = void 0;
		});
		try {
			return await this.inflight;
		} catch (error) {
			if (this.options.isPermanent(error)) {
				if (this.options.onInvalid !== void 0) await this.options.onInvalid(session);
				else {
					await this.options.remove();
					this.options.onRemoved?.();
				}
				throw new LlmError(`${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`, "INVALID_CREDENTIAL", { cause: error });
			}
			if (!forceRefresh && session.expiresAt > Date.now()) return session;
			throw error instanceof LlmError ? error : new LlmError(`${this.options.displayName} token refresh failed`, "AUTH", { cause: error });
		}
	}
	async doRefresh(session) {
		const current$2 = await this.options.load();
		if (current$2 !== void 0 && current$2.accessToken !== session.accessToken && current$2.expiresAt - Date.now() > this.options.preemptMs) return current$2;
		const previous = current$2 ?? session;
		const next = await this.options.refresh(previous);
		await this.options.save(next, previous);
		const saved = await this.options.load();
		if (saved === void 0) throw new LlmError(`${this.options.displayName}: подключение удалено во время обновления входа`, "MISSING_CREDENTIAL");
		return saved;
	}
};
/** Bound on one account catalog fetch or usage poll — a hang must not block the picker. */
const DISCOVERY_TIMEOUT_MS = 1e4;
/**
* Run `work` with an aborting signal. Resolves undefined when the timeout
* fires (the fetch is aborted); other failures propagate.
*/
function withTimeout(work, timeoutMs) {
	const signal = AbortSignal.timeout(timeoutMs);
	const aborted = new Promise((resolve) => {
		if (signal.aborted) resolve(void 0);
		else signal.addEventListener("abort", () => resolve(void 0), { once: true });
	});
	return Promise.race([work(signal).then((value) => signal.aborted ? void 0 : value, (error) => {
		if (signal.aborted) return void 0;
		throw error;
	}), aborted]);
}
/** Display name for a wire reasoning-effort identifier. */
function effortDisplayName(effort) {
	return effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);
}
/**
* Fold a configured per-model default effort into a reasoning block, keeping
* the DSH runtime invariant `defaultEffort ∈ efforts` (the runtime rejects an
* unknown default with `INVALID_MODEL_REASONING`).
*
* A configured level the base set does not advertise is *dropped*, not
* appended: for claude/grok/copilot the base is the provider's live catalog,
* i.e. the truth about what the model accepts, so honouring a stale override
* would put an unsupported effort on every single request instead of letting
* the harness reject it before provider I/O. The override then simply falls
* back to the provider's own default until the user picks a level the catalog
* still lists.
*
* `extendable` opts into the opposite rule for a base that is a *built-in
* fallback* rather than discovered truth (codex, whose static effort list is
* known to trail the backend): there, appending the configured level is how a
* newly shipped tier becomes selectable at all.
* @param configuredDefault - the user-configured default effort id, or undefined.
* @param base - the discovered/built-in reasoning block, or undefined.
* @param options - `extendable` marks the base as a fallback that may be extended.
* @returns the merged block, or undefined when neither side contributes one.
*/
function mergeReasoning(configuredDefault, base, options) {
	const detached = base === void 0 ? void 0 : {
		efforts: [...base.efforts],
		...base.defaultEffort === void 0 ? {} : { defaultEffort: base.defaultEffort }
	};
	if (configuredDefault === void 0) return detached;
	const effort = ReasoningEffortId(configuredDefault);
	if (base === void 0) return options?.extendable === true ? {
		efforts: [{
			id: effort,
			name: effortDisplayName(effort)
		}],
		defaultEffort: effort
	} : void 0;
	if (base.efforts.some((entry) => entry.id === effort)) return {
		efforts: [...base.efforts],
		defaultEffort: effort
	};
	if (options?.extendable !== true) return detached;
	return {
		efforts: [...base.efforts, {
			id: effort,
			name: effortDisplayName(effort)
		}],
		defaultEffort: effort
	};
}
/**
* First account catalog that lists `model` (callers pass default-first).
* One failing lookup sits that account out so a sibling's metadata still
* resolves — the same isolation as the picker catalog union.
*/
async function discoverAcrossAccounts(accounts, lookup) {
	for (const account of accounts) try {
		const found = await lookup(account);
		if (found !== void 0) return found;
	} catch {}
}
/** How long a discovered catalog is trusted before re-fetching. */
const DISCOVERY_TTL_MS = 5 * 6e4;
/**
* Cache for one provider's discovered model catalog. The TTL only decides
* when to REFRESH; it never makes the cache forget: capability metadata
* (reasoning efforts) must stay stable for a session that selected an effort,
* or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
* cache goes stale. `listModels` awaits freshness via {@link get};
* `resolveModel` uses {@link resolve}, which serves the last-known catalog
* while a stale entry refreshes in the background, and only awaits the fetch
* when nothing is known yet. An optional {@link CatalogPersistence} seeds the
* last-known state across restarts and receives every successful fetch. A 401
* that still fails after a forced token refresh must call {@link invalidate}.
*/
var ModelCatalogCache = class {
	entry;
	refreshRequested = false;
	inflight;
	/** Settles once the persisted snapshot (when any) has been considered. */
	seeded;
	/** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
	seedDisabled = false;
	/** Bumped by {@link invalidate} so a loser in-flight fetch cannot write back. */
	generation = 0;
	constructor(persistence, ttlMs = DISCOVERY_TTL_MS) {
		this.persistence = persistence;
		this.ttlMs = ttlMs;
	}
	/**
	* The cached catalog when fresh, without fetching.
	* @returns the cached models, or `undefined` when absent or stale.
	*/
	cached() {
		if (this.refreshRequested || this.entry === void 0 || Date.now() - this.entry.at >= this.ttlMs) return void 0;
		return this.entry.models;
	}
	/**
	* The last successfully fetched catalog, ignoring TTL. Used to carry
	* capability metadata forward when a later fetch cannot re-enrich.
	* @returns the last-known models, or `undefined` when nothing has been stored.
	*/
	lastKnown() {
		return this.entry?.models;
	}
	/** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
	ensureSeeded() {
		if (this.persistence === void 0) return Promise.resolve();
		this.seeded ??= this.persistence.load().then((snapshot) => {
			if (snapshot !== void 0 && this.entry === void 0 && !this.seedDisabled) this.entry = snapshot;
		}, () => void 0);
		return this.seeded;
	}
	/** Run (or join) the single in-flight fetch, updating memory and disk on success. */
	refresh(fetcher) {
		if (this.inflight !== void 0) return this.inflight;
		const gen = this.generation;
		const pending = fetcher().then((models) => {
			if (this.generation !== gen) return models;
			const snapshot = {
				at: Date.now(),
				models
			};
			this.entry = snapshot;
			this.refreshRequested = false;
			this.persistence?.save(snapshot).catch(() => void 0);
			return models;
		}).finally(() => {
			if (this.generation === gen) this.inflight = void 0;
		});
		this.inflight = pending;
		return pending;
	}
	/**
	* Return the cached catalog when fresh, otherwise fetch and cache it.
	* @param fetcher - performs the provider's model-list request.
	* @returns the discovered models.
	* @throws the fetcher's failure (the `listModels` caller warns and falls back).
	*/
	async get(fetcher) {
		await this.ensureSeeded();
		return this.cached() ?? this.refresh(fetcher);
	}
	/**
	* The models for capability resolution. A fresh cache answers directly; a
	* stale one answers immediately from the last-known catalog while a
	* background refresh runs (a mid-conversation `resolveModel` must neither
	* block on nor fail with the network); a cold cache awaits one fetch.
	* @param fetcher - performs the provider's model-list request.
	* @returns the models, or `undefined` when nothing is known (the caller
	*   falls back to its static metadata). Never throws.
	*/
	async resolve(fetcher) {
		await this.ensureSeeded();
		const fresh = this.cached();
		if (fresh !== void 0) return fresh;
		const known = this.entry?.models;
		if (known !== void 0) {
			this.refresh(fetcher).catch(() => void 0);
			return known;
		}
		try {
			return await this.refresh(fetcher);
		} catch {
			return;
		}
	}
	/** Request fresh metadata without discarding the last successful account snapshot. */
	revalidate() {
		this.generation += 1;
		this.inflight = void 0;
		this.refreshRequested = true;
	}
	/** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
	invalidate() {
		this.generation += 1;
		this.entry = void 0;
		this.inflight = void 0;
		this.seedDisabled = true;
		this.persistence?.clear().catch(() => void 0);
	}
};
/** Whether discovery failed because the stored login is gone. */
function isMissingOrInvalidCredential(error) {
	return error instanceof LlmError && (error.code === "MISSING_CREDENTIAL" || error.code === "INVALID_CREDENTIAL");
}
/** Whether discovery stopped because the caller cancelled or the timeout fired. */
function isDiscoveryAborted(error, signal) {
	if (signal?.aborted === true) return true;
	return signal !== void 0 && error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
/** Whether discovery failed because the access token was rejected. */
function isDiscoveryAuthFailure(error) {
	return error instanceof OAuthEndpointError && error.status === 401 || error instanceof LlmError && error.code === "AUTH";
}
/**
* Run a catalog fetch, retrying once after a forced token refresh when the
* first attempt is a 401/AUTH. Only {@link ModelCatalogCache.invalidate}s
* when the retry is also an auth failure, so a refresh race cannot erase
* last-known capability metadata.
*/
async function discoverOrRetryAuth(session, catalog, run, retainLastKnown = false) {
	try {
		return await run();
	} catch (error) {
		if (isMissingOrInvalidCredential(error) || !isDiscoveryAuthFailure(error)) throw error;
		try {
			await session(true);
			return await run();
		} catch (retryError) {
			if (!retainLastKnown && !isMissingOrInvalidCredential(retryError) && isDiscoveryAuthFailure(retryError)) catalog.invalidate();
			throw retryError;
		}
	}
}
/**
* Keep Codex's session header stable for a supplied, non-empty session ID.
* Existing UUIDs are preserved; other IDs use a SHA-256-derived UUIDv8 (a
* custom deterministic layout). UUID formatting is a client convention,
* not a claim about gateway validation or guaranteed prompt-cache hits.
* Missing and empty IDs have no session identity and receive a fresh UUIDv4.
*/
function deterministicSessionId(sessionId) {
	if (sessionId === void 0 || sessionId.length === 0) return randomUUID();
	const str = String(sessionId);
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)) return str;
	const bytes = createHash("sha256").update(str).digest().subarray(0, 16);
	bytes[6] = bytes[6] & 15 | 128;
	bytes[8] = bytes[8] & 63 | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

//#endregion
//#region src/providers/accounts.ts
/** Catalog sort hint when the provider advertised one (Codex `priority`). */
function catalogPriority(model) {
	const ranked = model;
	return typeof ranked.priority === "number" ? ranked.priority : Number.MAX_SAFE_INTEGER;
}
/**
* Merge per-account catalogs, keeping the first occurrence of each model id.
* Rows that carry a numeric `priority` (Codex discovery) are then ordered by
* it so a model only the second account lists — e.g. `gpt-5.6-sol` — still
* sits with its generation instead of being appended after the default
* account's older ids.
*/
async function unionAccountCatalogs(accounts, listOne, options) {
	const timeoutMs = options?.timeoutMs;
	const caller = options?.signal;
	const catalogs = await Promise.all(accounts.map(async (account) => {
		try {
			if (timeoutMs === void 0) return await listOne(account, caller);
			return await withTimeout((timeoutSignal) => listOne(account, caller === void 0 ? timeoutSignal : AbortSignal.any([timeoutSignal, caller])), timeoutMs) ?? [];
		} catch (error) {
			if (caller?.aborted === true) throw error;
			return [];
		}
	}));
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const catalog of catalogs) for (const model of catalog) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	models.sort((left, right) => catalogPriority(left) - catalogPriority(right));
	return models;
}
var AccountTokenManager = class {
	managers = /* @__PURE__ */ new Map();
	activity = new Map();
	io;
	constructor(options) {
		this.options = options;
		const provider = options.provider;
		this.io = options.io ?? {
			list: () => listAccounts(provider, options.authStorePath),
			get: (account) => getAccountSession(provider, account, options.authStorePath),
			save: (account, session, previous) => saveAccountSession(provider, account, session, options.authStorePath, provider === "codex" ? previous?.accessToken : void 0),
			remove: (account) => deleteAccountSession(provider, account, options.authStorePath)
		};
	}
	/** The provider's accounts, default first (straight from the store). */
	async list(includeUnavailable = false) {
		const entries = await this.io.list();
		return this.options.provider === "codex" && !includeUnavailable ? entries.filter(entry => entry.session.enabled !== false && entry.session.requiresLogin !== true) : entries;
	}
	/** The default account's key, or undefined when logged out. */
	async defaultAccount() {
		return (await this.list())[0]?.key;
	}
	/**
	* Resolve a usable session for one account (default when omitted),
	* refreshing proactively or on demand.
	* @param account - the account key; the default account when undefined.
	* @param forceRefresh - refresh regardless of expiry (used after a 401).
	* @returns the persisted session to send.
	* @throws LlmError MISSING_CREDENTIAL when the account is not logged in.
	*/
	async session(account, forceRefresh = false, rejectedAccessToken, allowDisabled = false) {
		const key = account ?? await this.defaultAccount();
		if (key === void 0) throw this.missingCredential();
		if (this.options.provider === "codex" && !allowDisabled && (await this.peek(key))?.enabled === false) throw new LlmError("Подписка Codex выключена. Включите «Использовать» в её карточке.", "MISSING_CREDENTIAL");
		const release = this.beginUse(key);
		try { return await this.tokensFor(key).session(forceRefresh, rejectedAccessToken); }
		finally { release(); }
	}
	/** Request lifetime and deletion share this synchronous boundary, including token refreshes. */
	beginUse(account) {
		const state = this.activity.get(account) ?? { active: 0, deleting: false };
		if (state.deleting) throw new LlmError("Подписка удаляется. Выберите доступное подключение.", "MISSING_CREDENTIAL");
		state.active++;
		this.activity.set(account, state);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.active--;
			if (state.active === 0 && !state.deleting) this.activity.delete(account);
		};
	}
	isActive(account) {
		return (this.activity.get(account)?.active ?? 0) > 0;
	}
	async removeAccount(account) {
		if (this.isActive(account)) throw new Error("Подписка сейчас используется. Дождитесь завершения ответа или отмените запрос, затем удалите подключение.");
		const state = this.activity.get(account) ?? { active: 0, deleting: false };
		if (state.deleting) throw new Error("Подписка уже удаляется.");
		state.deleting = true;
		this.activity.set(account, state);
		try {
			await this.io.remove(account);
			this.managers.delete(account);
		} finally { this.activity.delete(account); }
	}
	/** Read an account's stored session without any refresh side effect. */
	peek(account) {
		return this.io.get(account);
	}
	/** Whether a session is stored for the account (cheap; never refreshes). */
	async hasSession(account) {
		const session = await this.peek(account);
		return session !== void 0 && (this.options.provider !== "codex" || session.enabled !== false && session.requiresLogin !== true);
	}
	/** The TokenManager bound to one account (created lazily, then cached). */
	tokensFor(account) {
		let manager = this.managers.get(account);
		if (manager === void 0) {
			const io = this.io;
			manager = new TokenManager({
				displayName: this.options.displayName,
				...this.options.makeOptions(account),
				load: () => io.get(account),
				...(this.options.provider === "codex" ? { onInvalid: async session => {
					await markAccountRequiresLogin("codex", account, session.accessToken, this.options.authStorePath);
					this.options.onAccountRemoved?.(account);
				} } : {}),
				save: (session, previous) => io.save(account, session, previous),
				remove: () => io.remove(account),
				onRemoved: () => {
					this.options.onAccountRemoved?.(account);
				}
			});
			this.managers.set(account, manager);
		}
		return manager;
	}
	/** The logged-out error, mirroring TokenManager's own message. */
	missingCredential() {
		return new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; log in via Settings → Subscriptions in the dsh web app`, "MISSING_CREDENTIAL");
	}
};

//#endregion
//#region src/providers/catalog-store.ts
/**
* Absolute path of the catalog store file.
* @returns `dshHomePath('plugins', 'subscriptions', 'models.json')`.
*/
function modelsFilePath() {
	return dshHomePath("plugins", "airules-subscriptions", "models.json");
}
/** Validate one persisted reasoning block, or undefined when malformed. */
function sanitizeReasoning(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (!Array.isArray(raw.efforts) || raw.efforts.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const efforts = [];
	for (const entry of raw.efforts) {
		if (typeof entry !== "object" || entry === null) return void 0;
		const effort = entry;
		if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) return void 0;
		seen.add(effort.id);
		efforts.push({
			id: ReasoningEffortId(effort.id),
			name: effort.name,
			...effort.description === void 0 ? {} : { description: effort.description }
		});
	}
	if (raw.defaultEffort !== void 0 && (typeof raw.defaultEffort !== "string" || !seen.has(raw.defaultEffort))) return void 0;
	return {
		efforts,
		...raw.defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(raw.defaultEffort) }
	};
}
/** Validate one persisted model, or undefined when malformed. */
function sanitizeModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.name !== "string" || raw.name.length === 0 || raw.description !== void 0 && typeof raw.description !== "string" || raw.contextWindow !== void 0 && (typeof raw.contextWindow !== "number" || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0) || raw.maxContextWindow !== void 0 && (typeof raw.maxContextWindow !== "number" || !Number.isSafeInteger(raw.maxContextWindow) || raw.maxContextWindow <= 0) || raw.priority !== void 0 && (typeof raw.priority !== "number" || !Number.isFinite(raw.priority))) return void 0;
	const reasoning = raw.reasoning === void 0 ? void 0 : sanitizeReasoning(raw.reasoning);
	if (raw.reasoning !== void 0 && reasoning === void 0) return void 0;
	const thinkingType = raw.thinkingType;
	if (thinkingType !== void 0 && thinkingType !== "enabled" && thinkingType !== "adaptive") return void 0;
	const fastTier = raw.fastTier;
	if (fastTier !== void 0 && typeof fastTier !== "boolean") return void 0;
	const copilotWire = raw.copilotWire;
	if (copilotWire !== void 0 && copilotWire !== "chat-completions" && copilotWire !== "responses") return;
	const copilotResponses = raw.copilotResponses;
	if (copilotResponses !== void 0 && typeof copilotResponses !== "boolean") return void 0;
	const inputModalities = raw.inputModalities;
	if (inputModalities !== void 0 && (!Array.isArray(inputModalities) || inputModalities.length === 0 || inputModalities.some((modality) => modality !== "text" && modality !== "image"))) return void 0;
	return {
		id: raw.id,
		name: raw.name,
		...raw.description === void 0 ? {} : { description: raw.description },
		...raw.contextWindow === void 0 ? {} : { contextWindow: raw.contextWindow },
		...raw.maxContextWindow === void 0 ? {} : { maxContextWindow: raw.maxContextWindow },
		...raw.priority === void 0 ? {} : { priority: raw.priority },
		...reasoning === void 0 ? {} : { reasoning },
		...thinkingType === void 0 ? {} : { thinkingType },
		...fastTier === void 0 ? {} : { fastTier },
		...copilotWire === void 0 ? {} : { copilotWire },
		...copilotResponses === void 0 ? {} : { copilotResponses },
		...inputModalities === void 0 ? {} : { inputModalities: [...inputModalities] }
	};
}
/**
* Validate one persisted snapshot. Strict: any malformed field drops the
* whole snapshot rather than repairing it — the next successful discovery
* rewrites the entry anyway.
* @param value - the raw per-provider file entry.
* @returns the validated snapshot, or undefined when unusable.
*/
function sanitizeSnapshot(value, allowEmpty = false) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return void 0;
	if (!Array.isArray(raw.models) || !allowEmpty && raw.models.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const entry of raw.models) {
		const model = sanitizeModel(entry);
		if (model === void 0 || seen.has(model.id)) return void 0;
		seen.add(model.id);
		models.push(model);
	}
	return {
		at: raw.at,
		models
	};
}
/** Read the whole file; missing or unparsable reads as an empty cache. */
async function readCatalogFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/** Persist the whole file atomically (tmp file + rename). */
async function writeCatalogFile(store, path) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2));
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Build the durable half of one provider's catalog cache over the shared
* models.json file (concurrent writers are last-writer-wins, acceptable for
* a cache).
* @param provider - the provider route keying the file entry.
* @param path - store file path; defaults to {@link modelsFilePath}.
* @returns the persistence hooks for {@link ModelCatalogCache}.
*/
function catalogStore(provider, path = modelsFilePath()) {
	return {
		async load() {
			return sanitizeSnapshot((await readCatalogFile(path))[provider], provider.startsWith("codex:"));
		},
		async save(snapshot) {
			return serialize(path, async () => {
				const store = await readCatalogFile(path);
				store[provider] = snapshot;
				await writeCatalogFile(store, path);
			});
		},
		async clear() {
			return serialize(path, async () => {
				const store = await readCatalogFile(path);
				if (store[provider] === void 0) return;
				delete store[provider];
				await writeCatalogFile(store, path);
			});
		}
	};
}

//#endregion
//#region src/auth/jwt.ts
/** Minimal JWT payload decoding for claims extraction (no signature verification). */
/**
* Decode a JWT payload without verifying the signature. Used only to read
* account claims from `id_token`s issued over the provider's own TLS channel
* during a code exchange we initiated — never to authorize anything.
* @param token - the compact JWT string.
* @returns the parsed payload object, or `undefined` when the token is not a
*   well-formed JWT with a JSON object payload.
*/
function decodeJwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	return parsed;
}

//#endregion
//#region src/translate/resolved.ts
/**
* Wires with text-only tool outputs receive images in a following user turn.
* Defer that turn until all consecutive user messages have been processed:
* parallel tool results can arrive in separate harness messages, and a user
* image message must not interrupt their tool-call/output pairing.
*/
function withToolResultImages(messages) {
	const out = [];
	let images = [];
	const flush = () => {
		if (images.length > 0) out.push({
			role: "user",
			content: images
		});
		images = [];
	};
	for (const message of messages) {
		if (message.role === "assistant") flush();
		out.push(message);
		for (const block of message.content) {
			if (block.type !== "tool-result") continue;
			const parts = block.content.filter((part) => part.type === "image" && "dataBase64" in part);
			if (parts.length > 0) images.push({
				type: "text",
				text: `Images from tool result ${String(block.toolCallId)}:`
			}, ...parts);
		}
	}
	flush();
	return out;
}
/**
* Resolve every ImageBlock's attachment reference to inline base64 bytes.
* Messages without images pass through unchanged. A request carrying an image
* with no attachment service available fails loudly rather than silently
* dropping the image.
* @param messages - the request's conversation messages.
* @param attachments - the deployment's attachment service, when mounted.
* @param signal - cancellation for the storage reads.
* @returns the same messages with image blocks resolved for the translators.
*/
async function resolveImages(messages, attachments, signal) {
	const hasImage = (block) => block.type === "image" || block.type === "tool-result" && block.content.some(hasImage);
	if (!messages.some((message) => message.content.some(hasImage))) return messages;
	if (attachments === void 0) throw new LlmError("dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; image input requires the harness attachment store", "UNSUPPORTED");
	const resolveBlock = async (block) => {
		if (block.type === "tool-result") return [{
			...block,
			content: (await Promise.all(block.content.map(resolveBlock))).flat()
		}];
		if (block.type !== "image") return [block];
		const stored = await attachments.readImage(block.attachment, signal);
		const { attachmentId, mediaType, bytes, width, height, name: name$1 } = stored.ref;
		return [{
			type: "image",
			mediaType: stored.ref.mediaType,
			dataBase64: Buffer.from(stored.data).toString("base64")
		}, {
			type: "text",
			text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
				attachmentId,
				mediaType,
				bytes,
				width,
				height,
				...name$1 === void 0 ? {} : { name: name$1 }
			})}`
		}];
	};
	return Promise.all(messages.map(async (message) => ({
		role: message.role,
		content: (await Promise.all(message.content.map(resolveBlock))).flat()
	})));
}

//#endregion
//#region src/compat.ts
/** Brand a string as a tool-call id: alpha's `ToolCallId`, rc.2's `CallId`. */
const ToolCallId = (() => {
	const exports = llm;
	return exports["ToolCallId"] ?? exports["CallId"];
})();

//#endregion
//#region src/translate/sse.ts
/**
* Decode an SSE byte stream into events.
* @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onActivity - called on every received chunk and comment line; drives the idle watchdog.
* @returns events in arrival order.
*/
async function* parseSse(stream, onActivity) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let dataLines = [];
	let eventName;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			onActivity?.();
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				let line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length === 0) {
					if (dataLines.length > 0) yield {
						data: dataLines.join("\n"),
						...eventName === void 0 ? {} : { event: eventName }
					};
					dataLines = [];
					eventName = void 0;
				} else if (line.startsWith(":")) onActivity?.();
				else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
				else if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

//#endregion
//#region src/translate/responses.ts
/** Flatten a tool result's content to plain text for `function_call_output`. */
function toolResultText$1(block) {
	return block.content.map((part) => part.type === "text" ? part.text : "").join("");
}
/**
* Convert harness messages into Responses `instructions` + `input` items.
* System-role messages become `instructions`; an explicit `system` argument
* wins over them when both exist. Reasoning blocks are never replayed in
* their text form: a Responses model continuing past a tool call needs its
* reasoning back as the provider's completed reasoning items (id, summary,
* and the ENCRYPTED payload), so `reasoningFor` may resolve per-call
* captured items, replayed ahead of the matching function_call item. Images
* must arrive pre-resolved
* ({@link TranslatableMessage}); an unresolved ImageBlock is skipped because
* its bytes are unreachable here.
* @param messages - ordered conversation messages with resolved images.
* @param system - explicit system prompt, which takes precedence.
* @param reasoningFor - resolves one tool call id to the COMPLETED reasoning
*   items captured for it (id, summary, status, encrypted payload), replayed
*   ahead of the matching function_call item, when the adapter kept them.
* @returns request fields ready to merge into the request body.
*/
function toResponsesInput(messages, system, reasoningFor) {
	const input = [];
	const systemTexts = [];
	let lastReplay;
	for (const message of withToolResultImages(messages)) {
		if (message.role === "system") {
			for (const block of message.content) if (block.type === "text") systemTexts.push(block.text);
			continue;
		}
		const role = message.role;
		let content = [];
		const flushMessage = () => {
			if (content.length === 0) return;
			input.push({
				type: "message",
				role,
				content
			});
			content = [];
		};
		for (const block of message.content) switch (block.type) {
			case "text":
				content.push({
					type: role === "assistant" ? "output_text" : "input_text",
					text: block.text
				});
				break;
			case "tool-call": {
				flushMessage();
				const encrypted = reasoningFor?.(String(block.id));
				if (encrypted !== void 0 && encrypted !== lastReplay) {
					for (const item of encrypted) input.push({
						type: "reasoning",
						...item.id === void 0 ? {} : { id: item.id },
						...item.summary === void 0 ? {} : { summary: item.summary },
						...item.status === void 0 ? {} : { status: item.status },
						encrypted_content: item.encrypted_content
					});
					lastReplay = encrypted;
				}
				input.push({
					type: "function_call",
					call_id: String(block.id),
					name: block.name,
					arguments: block.arguments
				});
				break;
			}
			case "tool-result":
				flushMessage();
				input.push({
					type: "function_call_output",
					call_id: String(block.toolCallId),
					output: toolResultText$1(block)
				});
				break;
			case "image":
				if ("dataBase64" in block) content.push({
					type: "input_image",
					image_url: `data:${block.mediaType};base64,${block.dataBase64}`
				});
				break;
			default: break;
		}
		flushMessage();
	}
	const instructions = system ?? (systemTexts.length > 0 ? systemTexts.join("\n\n") : void 0);
	return {
		...instructions === void 0 ? {} : { instructions },
		input
	};
}
/**
* Map harness tool schemas to Responses function tools.
*
* OpenAI Responses may normalize schemas into strict mode when `strict` is
* omitted. Codex and Copilot opt out to preserve harness optional parameters;
* this does not prevent a model from voluntarily supplying optional fields.
* Other providers keep their existing defaults unless explicitly opted out.
* @param tools - tool schemas from the request.
* @param options - provider-specific opt-out from strict schema normalization.
* @returns Responses `tools` array entries.
*/
function toResponsesTools(tools, options = {}) {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...options.strict === void 0 ? {} : { strict: options.strict }
	}));
}
/**
* Map Responses usage to disjoint harness counts (cached input is subtracted
* out of `inputTokens` and reported as `cacheReadTokens`).
* @param usage - wire usage from `response.completed`.
* @returns harness token usage.
*/
function mapResponsesUsage(usage) {
	const cached = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.input_tokens - (cached ?? 0),
		outputTokens: usage.output_tokens,
		...cached !== void 0 ? { cacheReadTokens: cached } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
* Classify a Responses failure payload into a thrown LlmError.
* @param code - provider error code, when present.
* @param message - provider error message, when present.
* @returns the mapped error (context overflow, quota, otherwise SERVER).
*/
function responsesFailure(code, message) {
	const text = message ?? code ?? "the provider reported a failed response";
	const detail = `${code ?? ""} ${message ?? ""}`;
	if (code === "context_window_exceeded" || isContextWindowExceededError(detail)) return new LlmError(text, CONTEXT_WINDOW_EXCEEDED_CODE);
	if (code !== void 0 && /insufficient|quota/i.test(code) || isQuotaExceededError(detail)) return new LlmError(text, QUOTA_EXCEEDED_CODE);
	return new LlmError(text, "SERVER");
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock$2(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Push-model Responses SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes
* are allocated in first-seen order; `usage` is emitted before the terminal
* `finish`, and nothing is emitted after it. Terminal provider failures
* throw {@link LlmError}.
*/
var ResponsesStreamTranslator = class {
	blocks = /* @__PURE__ */ new Map();
	order = [];
	nextIndex = 0;
	sawToolCall = false;
	/** Set once `response.completed` produced the terminal finish chunk. */
	terminated = false;
	open(key, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(key, block);
		this.order.push(block);
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	textBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "text", chunks);
	}
	reasoningBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "reasoning", chunks);
	}
	close(key, chunks) {
		const block = this.blocks.get(key);
		if (block === void 0) return;
		this.blocks.delete(key);
		chunks.push({
			type: "block-end",
			index: block.index,
			block: closeBlock$2(block)
		});
	}
	/** Close every still-open block for one output item (prefix match on the key). */
	closeItem(itemId, chunks) {
		for (const key of [...this.blocks.keys()]) if (key.startsWith(`${itemId}:`)) this.close(key, chunks);
	}
	/** Close every still-open block (provider ended the response without done events). */
	closeAll(chunks) {
		for (const block of this.order) this.closeKeyIfOpen(block, chunks);
	}
	closeKeyIfOpen(block, chunks) {
		for (const [key, candidate] of this.blocks) if (candidate === block) {
			this.blocks.delete(key);
			chunks.push({
				type: "block-end",
				index: block.index,
				block: closeBlock$2(block)
			});
			return;
		}
	}
	/**
	* Process one parsed Responses SSE event.
	* @param event - the parsed event object.
	* @returns the StreamChunks this event produced (possibly none).
	*/
	push(event) {
		if (this.terminated) return [];
		const chunks = [];
		switch (event.type) {
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type === "function_call" && item.id !== void 0) {
					this.sawToolCall = true;
					const callId = item.call_id ?? "";
					const block = this.open(`${item.id}:call`, "tool-call", chunks, callId, item.name);
					chunks.push({
						type: "tool-call-delta",
						index: block.index,
						id: ToolCallId(callId),
						...item.name === void 0 ? {} : { name: item.name },
						argumentsDelta: ""
					});
				}
				return chunks;
			}
			case "response.output_text.delta": {
				const key = `${event.item_id ?? ""}:text:${String(event.content_index ?? 0)}`;
				const block = this.textBlock(key, chunks);
				block.text += event.delta ?? "";
				chunks.push({
					type: "text-delta",
					index: block.index,
					text: event.delta ?? ""
				});
				return chunks;
			}
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta": {
				const sub = event.summary_index ?? event.content_index ?? 0;
				const key = `${event.item_id ?? ""}:reason:${String(sub)}`;
				const block = this.reasoningBlock(key, chunks);
				block.text += event.delta ?? "";
				chunks.push({
					type: "reasoning-delta",
					index: block.index,
					text: event.delta ?? ""
				});
				return chunks;
			}
			case "response.function_call_arguments.delta": {
				const key = `${event.item_id ?? ""}:call`;
				let block = this.blocks.get(key);
				if (block === void 0) {
					this.sawToolCall = true;
					block = this.open(key, "tool-call", chunks);
				}
				block.text += event.delta ?? "";
				chunks.push({
					type: "tool-call-delta",
					index: block.index,
					id: ToolCallId(block.callId),
					...block.name === void 0 ? {} : { name: block.name },
					argumentsDelta: event.delta ?? ""
				});
				return chunks;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item === void 0 || item.id === void 0) return chunks;
				if (item.type === "function_call") {
					const key = `${item.id}:call`;
					const block = this.blocks.get(key);
					if (block !== void 0 && block.text.length === 0 && item.arguments !== void 0) block.text = item.arguments;
					this.close(key, chunks);
				} else if (item.type === "message") {
					if (![...this.blocks.keys()].some((key) => key.startsWith(`${item.id}:text:`))) for (const [partIndex, part] of (item.content ?? []).entries()) {
						if (part?.type !== "output_text" || typeof part.text !== "string" || part.text.length === 0) continue;
						const block = this.open(`${item.id}:text:${partIndex}`, "text", chunks);
						block.text = part.text;
						this.close(`${item.id}:text:${partIndex}`, chunks);
					}
					this.closeItem(item.id, chunks);
				} else this.closeItem(item.id, chunks);
				return chunks;
			}
			case "response.completed": {
				this.terminated = true;
				this.closeAll(chunks);
				const usage = event.response?.usage;
				if (usage !== void 0) chunks.push({
					type: "usage",
					usage: mapResponsesUsage(usage)
				});
				if (this.order.length === 0) chunks.push({
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "model returned a completed response with no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				});
				else chunks.push({
					type: "finish",
					reason: { kind: this.sawToolCall ? "tool-calls" : "stop" }
				});
				return chunks;
			}
			case "response.failed": throw responsesFailure(event.response?.error?.code, event.response?.error?.message);
			case "response.incomplete": throw responsesFailure(event.response?.incomplete_details?.reason, event.response?.error?.message ?? `the provider reported an incomplete response (${event.response?.incomplete_details?.reason ?? "unknown reason"})`);
			case "error": throw responsesFailure(event.code, event.message);
			default: return chunks;
		}
	}
};
/**
* Consume a Responses SSE byte stream and yield harness StreamChunks.
* @param stream - raw response body.
* @param onActivity - transport-activity callback for the idle watchdog.
* @param transform - optional per-event rewrite applied before translation
*   (Copilot's gateway mints a fresh item id per event; the adapter rewrites
*   them into stable per-item keys).
* @returns the chunk stream; throws when the stream ends before `response.completed`.
*/
async function* streamResponses(stream, onActivity, transform) {
	const translator = new ResponsesStreamTranslator();
	for await (const sseEvent of parseSse(stream, onActivity)) {
		let event;
		try {
			event = JSON.parse(sseEvent.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		if (transform !== void 0) event = transform(event);
		yield* translator.push(event);
		if (translator.terminated) return;
	}
	throw new LlmError("Responses SSE stream ended before response.completed", "STREAM_CLOSED");
}

//#endregion
//#region src/providers/codex.ts
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_CALLBACK_PATH = "/auth/callback";
const CODEX_CONTEXT_WINDOW = 4e5;
const CODEX_DEFAULT_MAX_TOKENS = 128e3;
/** Refresh when the access token has less than this much life left. */
const CODEX_PREEMPT_MS = 5 * 6e4;
/**
* Body fields the backend uses to name a reset. A window-exhaustion rejection
* carries `usage_limit_reached` with the seconds left on the window — the case
* that used to classify as a terminal quota and never be retried at all.
*/
const CODEX_RESET_FIELDS = [
	"resets_in_seconds",
	"reset_after_seconds",
	"resets_at",
	"reset_at"
];
/**
* Reads the reset instant of the Codex window that rejected a request.
*
* Body only. The `x-codex-{primary,secondary}-reset-after-seconds` headers are
* rollover snapshots the backend attaches to every response, one per window,
* so they say nothing about which window refused: a burst 429 that would clear
* in seconds still carries a primary rollover hours out, and reading it would
* park the turn for those hours. They reach the operator through
* `rateLimitDiagnostics` instead.
*/
const codexRateLimitReset = (_response, body, now) => resetFromFields(jsonBody(body), CODEX_RESET_FIELDS, now);
/** Default instruction when the request carries no system prompt. */
const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex, a coding agent based on GPT-5. Help the user with their software engineering tasks.";
/** Refresh-grant rejections that mean the login is gone for good. */
const PERMANENT_REFRESH_CODES = new Set([
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
	"invalid_grant"
]);
const CODEX_EFFORTS = [
	{
		id: ReasoningEffortId("minimal"),
		name: "Minimal"
	},
	{
		id: ReasoningEffortId("low"),
		name: "Low"
	},
	{
		id: ReasoningEffortId("medium"),
		name: "Medium"
	},
	{
		id: ReasoningEffortId("high"),
		name: "High"
	},
	{
		id: ReasoningEffortId("xhigh"),
		name: "Extra High"
	}
];
const CODEX_DEFAULT_EFFORT = ReasoningEffortId("high");
/** Every gpt-5.x codex model accepts image input. */
const CODEX_MODALITIES = ["text", "image"];
/**
* Fast tier (the codex CLI's "fast mode"): the Responses `service_tier` wire
* value for priority processing, mirroring codex-rs
* `ServiceTier::Fast.request_value()`. The legacy catalog spelling is the
* `additional_speed_tiers` entry "fast".
*/
const CODEX_FAST_SERVICE_TIER = "priority";
const CODEX_FAST_SPEED_TIER = "fast";
/** Static codex flow facts for the OAuth flow engine. */
const codexFlow = {
	callbackPath: CODEX_CALLBACK_PATH,
	listen: {
		host: "localhost",
		ports: [1455, 1457]
	},
	buildAuthorizeUrl({ redirectUri, state, pkce }) {
		return `${CODEX_AUTHORIZE_URL}?${new URLSearchParams({
			response_type: "code",
			client_id: CODEX_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: CODEX_SCOPE,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			state,
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "codex_cli_rs"
		}).toString()}`;
	}
};
/** Pull `chatgpt_account_id` out of an id token payload. */
function accountIdOf(idToken) {
	const auth = (idToken === void 0 ? void 0 : decodeJwtPayload(idToken))?.["https://api.openai.com/auth"];
	const accountId = typeof auth === "object" && auth !== null ? auth.chatgpt_account_id : void 0;
	if (typeof accountId !== "string" || accountId.length === 0) throw new Error("codex login did not return a chatgpt account id; cannot use the subscription");
	return accountId;
}
/**
* Decode the user-identity claims of a codex id token (pure, cheap — no
* verification, same trust posture as {@link accountIdOf}). Claim paths
* mirror codex-rs `login/src/token_data.rs`: the email is the top-level
* `email` claim, falling back to `https://api.openai.com/profile`.email; the
* plan is `https://api.openai.com/auth`.chatgpt_plan_type.
* @param idToken - a stored or freshly issued id token, when present.
* @returns whichever claims the token carried; empty when undecodable.
*/
function codexProfileClaims(idToken) {
	const payload = idToken === void 0 ? void 0 : decodeJwtPayload(idToken);
	if (payload === void 0) return {};
	const profile = payload["https://api.openai.com/profile"];
	const profileEmail = typeof profile === "object" && profile !== null ? profile.email : void 0;
	const email = payload.email ?? profileEmail;
	const auth = payload["https://api.openai.com/auth"];
	const plan = typeof auth === "object" && auth !== null ? auth.chatgpt_plan_type : void 0;
	return {
		...typeof email === "string" && email.length > 0 ? { emailAddress: email } : {},
		...typeof plan === "string" && plan.length > 0 ? { planType: plan } : {}
	};
}
/** Build a session from a token response; expires_in wins, JWT exp is the fallback. */
function codexSession(tokens, fallback) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("codex token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
	if (refreshToken === void 0) throw new Error("codex token endpoint returned no refresh token");
	let expiresAt;
	if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) expiresAt = Date.now() + tokens.expires_in * 1e3;
	else {
		const exp = decodeJwtPayload(tokens.access_token)?.exp;
		if (typeof exp === "number" && exp > 0) expiresAt = exp * 1e3;
	}
	if (expiresAt === void 0) throw new Error("codex token endpoint returned no usable expiry");
	const idToken = tokens.id_token ?? fallback?.idToken;
	const claims = {
		...fallback?.emailAddress === void 0 ? {} : { emailAddress: fallback.emailAddress },
		...fallback?.planType === void 0 ? {} : { planType: fallback.planType },
		...codexProfileClaims(tokens.id_token)
	};
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt,
		accountId: tokens.id_token === void 0 && fallback !== void 0 ? fallback.accountId : accountIdOf(tokens.id_token),
		...idToken === void 0 ? {} : { idToken },
		...claims
	};
}
/**
* Exchange an authorization code for a codex session (form-encoded grant).
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @returns the session to store.
*/
async function exchangeCodexCode(code, verifier, redirectUri) {
	const response = await proxiedFetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CODEX_CLIENT_ID,
			code_verifier: verifier
		}).toString()
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex");
	return codexSession(await response.json());
}
/**
* Refresh a codex session (JSON grant — unlike the code exchange).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshCodex(session) {
	const response = await proxiedFetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: CODEX_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: session.refreshToken
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex");
	return codexSession(await response.json(), session);
}
/**
* Whether a codex refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isCodexPermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && error.oauthCode !== void 0 && PERMANENT_REFRESH_CODES.has(error.oauthCode);
}
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** Seconds of the canonical 5-hour session and 7-day weekly windows. */
const SESSION_WINDOW_SECONDS = 300 * 60;
const WEEKLY_WINDOW_SECONDS = 10080 * 60;
/** Whether a reported duration approximately matches the expected window length. */
function matchesWindow(seconds, expected) {
	return seconds >= expected * .95 && seconds <= expected * 1.05;
}
/**
* Classify a wham/usage window by its reported duration. The backend has been
* observed to place the weekly lane in `primary_window` with no secondary
* window, so slot position alone is unreliable; the caller's positional
* fallback applies only when the duration is absent.
*/
function codexWindowKind(window, fallback) {
	const seconds = window.limit_window_seconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
	if (matchesWindow(seconds, SESSION_WINDOW_SECONDS)) return "session";
	if (matchesWindow(seconds, WEEKLY_WINDOW_SECONDS)) return "weekly";
	return "other";
}
/** Map one wham/usage window into a {@link UsageWindow}; undefined when unusable. */
function codexUsageWindow(value, fallbackKind) {
	if (typeof value !== "object" || value === null) return void 0;
	const window = value;
	if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return void 0;
	let resetsAt;
	if (typeof window.reset_at === "number" && window.reset_at > 0) resetsAt = window.reset_at * 1e3;
	else if (typeof window.reset_after_seconds === "number" && window.reset_after_seconds > 0) resetsAt = Date.now() + window.reset_after_seconds * 1e3;
	return {
		kind: codexWindowKind(window, fallbackKind),
		usedPercent: window.used_percent,
		...resetsAt === void 0 ? {} : { resetsAt }
	};
}
// Display projection only; routing keeps the native windows unchanged.
function codexDisplayWindow(value, fallbackKind) {
	if (typeof value !== "object" || value === null) return void 0;
	const window = value;
	const usedPercent = typeof window.used_percent === "number" && Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100 ? window.used_percent : null;
	let resetsAt;
	if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at) && window.reset_at > 0) resetsAt = window.reset_at * 1e3;
	else if (typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds >= 0) resetsAt = Date.now() + window.reset_after_seconds * 1e3;
	return {
		kind: codexWindowKind(window, fallbackKind),
		usedPercent,
		...typeof window.limit_window_seconds === "number" && Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0 ? { durationSeconds: window.limit_window_seconds } : {},
		...resetsAt === void 0 ? {} : { resetsAt }
	};
}
/**
* Fetch the codex subscription usage from the ChatGPT backend wham/usage
* endpoint (the source of the codex CLI `/status` rate-limit lines). The
* windows are classified by their reported duration (`limit_window_seconds`)
* rather than by slot, since the backend has been observed to report the
* weekly lane as `primary_window` without a secondary window; slot order is
* kept only as a fallback when the duration is absent. The lookup itself
* consumes no rate-limit budget.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchCodexUsage(session, fetchFn = proxiedFetch, signal) {
	const response = await fetchFn(CODEX_USAGE_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"chatgpt-account-id": session.accountId,
			"originator": "codex_cli_rs",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex usage");
	const payload = await response.json();
	const windows = [];
	const primary = codexUsageWindow(payload.rate_limit?.primary_window, "session");
	const secondary = codexUsageWindow(payload.rate_limit?.secondary_window, "weekly");
	const displayWindows = [codexDisplayWindow(payload.rate_limit?.primary_window, "session"), codexDisplayWindow(payload.rate_limit?.secondary_window, "weekly")].filter(window => window !== undefined);
	if (primary !== void 0) windows.push(primary);
	if (secondary !== void 0) windows.push(secondary);
	return {
		supported: true,
		windows,
        displayWindows,
		...typeof payload.plan_type === "string" && payload.plan_type.length > 0 ? { plan: payload.plan_type } : {}
	};
}
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/**
* Client version sent on the /models catalog request. The backend gates the
* visible model list by client version. Verified 2026-09-05: the same account
* omitted GPT-6 Astra at 0.147.0 and listed it at stable CLI 0.153.4. This is
* not an entitlement guarantee; the server remains authoritative.
*/
const CODEX_CLIENT_VERSION = "0.164.0";
/** Validate an explicit catalog compatibility version before using it on the wire. */
function codexClientVersion(value = CODEX_CLIENT_VERSION) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) throw new Error("codexClientVersion must be a version such as 0.153.4");
	return value;
}
/**
* Whether a catalog entry advertises the fast tier. Mirrors codex-rs
* `ModelPreset::supports_fast_mode`: a `service_tiers` id matching the fast
* wire value, or the legacy `additional_speed_tiers` "fast" entry.
*/
function supportsFastTier(entry) {
	return (entry.service_tiers ?? []).some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER);
}
/**
* Fetch the live codex model catalog with the session's auth headers.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation (pool-assembly timeout).
* @param clientVersion - catalog compatibility version, not the plugin version.
* @returns discovered models: hidden entries dropped, sorted by priority.
*/
async function fetchCodexModels(session, fetchFn = proxiedFetch, signal, clientVersion = CODEX_CLIENT_VERSION) {
	const version = codexClientVersion(clientVersion);
	const response = await fetchFn(`${CODEX_MODELS_URL}?client_version=${encodeURIComponent(version)}`, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"chatgpt-account-id": session.accountId,
			"originator": "codex_cli_rs",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex models");
	const payload = await response.json();
	if (!Array.isArray(payload.models)) throw new Error("codex models endpoint returned no models array");
	const discovered = [];
	for (const entry of payload.models) {
		if (typeof entry.slug !== "string" || entry.slug.length === 0) continue;
		if (entry.visibility === "hide" || entry.visibility === "none") continue;
		const efforts = (entry.supported_reasoning_levels ?? []).filter((level) => typeof level.effort === "string" && level.effort.length > 0).map((level) => ({
			id: ReasoningEffortId(level.effort),
			name: effortDisplayName(level.effort),
			...level.description === void 0 ? {} : { description: level.description }
		}));
		const defaultEffort = typeof entry.default_reasoning_level === "string" && entry.default_reasoning_level.length > 0 && efforts.some((effort) => effort.id === ReasoningEffortId(entry.default_reasoning_level)) ? ReasoningEffortId(entry.default_reasoning_level) : void 0;
		const model = {
			id: entry.slug,
			name: typeof entry.display_name === "string" && entry.display_name.length > 0 ? entry.display_name : entry.slug,
			...typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {},
			...typeof entry.context_window === "number" && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
			...Number.isSafeInteger(entry.max_context_window) && entry.max_context_window > 0 ? { maxContextWindow: entry.max_context_window } : {},
			...typeof entry.priority === "number" ? { priority: entry.priority } : {},
			...efforts.length > 0 ? { reasoning: {
				efforts,
				...defaultEffort === void 0 ? {} : { defaultEffort }
			} } : {},
			...supportsFastTier(entry) ? { fastTier: true } : {}
		};
		discovered.push(model);
	}
	discovered.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
	if (discovered.length === 0) throw new Error(`codex models endpoint returned an empty catalog (client_version ${version})`);
	return discovered;
}
const CODEX_CALL_ID_MAX_LENGTH = 64;
const CODEX_CALL_ID_PREFIX = "call_";
/**
* Bound tool-call ids at the Codex wire boundary without changing the shared
* Responses translation used by Grok. Short ids stay verbatim. Oversized ids
* become deterministic hashes, and every id already present in this request
* is reserved first so a generated id cannot collide with a legitimate short
* one (or another oversized id).
*/
function normalizeCodexCallIds(input) {
	const mapping = /* @__PURE__ */ new Map();
	const used = /* @__PURE__ */ new Set();
	const callId = (item) => (item.type === "function_call" || item.type === "function_call_output") && typeof item.call_id === "string" ? item.call_id : void 0;
	for (const item of input) {
		const id = callId(item);
		if (id !== void 0 && id.length <= CODEX_CALL_ID_MAX_LENGTH) {
			mapping.set(id, id);
			used.add(id);
		}
	}
	for (const item of input) {
		const id = callId(item);
		if (id === void 0 || mapping.has(id)) continue;
		let attempt = 0;
		let normalized;
		do {
			const hash = createHash("sha256");
			if (attempt > 0) hash.update(String(attempt)).update("\0");
			normalized = `${CODEX_CALL_ID_PREFIX}${hash.update(id).digest("hex").slice(0, CODEX_CALL_ID_MAX_LENGTH - 5)}`;
			attempt += 1;
		} while (used.has(normalized));
		mapping.set(id, normalized);
		used.add(normalized);
	}
	return input.map((item) => {
		const id = callId(item);
		if (id === void 0) return item;
		const normalized = mapping.get(id) ?? id;
		return normalized === id ? item : {
			...item,
			call_id: normalized
		};
	});
}
/** Text marking a repaired tool output as an unknown outcome; the model must verify before retrying. */
const CODEX_UNKNOWN_TOOL_OUTCOME = "The tool call has no recorded result. Its outcome is unknown; verify external state before retrying any operation that may have side effects.";
/**
* Reconcile one Responses input's tool-call pairing after id normalization:
* every `function_call` gets an output and every `function_call_output`
* matches a call. Missing outputs become error-style outputs whose text marks
* the outcome unknown; orphan outputs are dropped. Duplicate calls of one id
* receive exactly one repair output. The request is local repair only: the
* durable history stays authoritative and unchanged.
* @param input - normalized Responses input items.
* @returns the same array when already balanced, otherwise a repaired array.
*/
function reconcileResponsesToolCalls(input) {
	const calls = /* @__PURE__ */ new Set();
	const outputs = /* @__PURE__ */ new Set();
	for (const item of input) if (item.type === "function_call" && typeof item.call_id === "string") calls.add(item.call_id);
	else if (item.type === "function_call_output" && typeof item.call_id === "string") outputs.add(item.call_id);
	const missing = new Set([...calls].filter((callId) => !outputs.has(callId)));
	if (missing.size === 0 && [...outputs].every((callId) => calls.has(callId))) return input;
	const balanced = [];
	for (const item of input) {
		if (item.type === "function_call_output" && (typeof item.call_id !== "string" || !calls.has(item.call_id))) continue;
		balanced.push(item);
		if (item.type === "function_call" && typeof item.call_id === "string" && missing.delete(item.call_id)) balanced.push({
			type: "function_call_output",
			call_id: item.call_id,
			output: CODEX_UNKNOWN_TOOL_OUTCOME
		});
	}
	return balanced;
}
/**
* The Responses request body for one generation. A fast-tier request (the
* composer Speed toggle, the codex CLI's fast mode) carries
* `service_tier: priority`; the tier field is omitted entirely otherwise,
* matching the CLI (it never sends an explicit standard tier).
*/
function codexRequestBody(options, resolved, fast) {
	return {
		model: options.model,
		instructions: resolved.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
		input: reconcileResponsesToolCalls(normalizeCodexCallIds(resolved.input)),
		...options.tools !== void 0 && options.tools.length > 0 ? {
			tools: toResponsesTools(options.tools, { strict: false }),
			tool_choice: "auto",
			parallel_tool_calls: true
		} : {},
		...options.reasoningEffort !== void 0 ? { reasoning: {
			effort: String(options.reasoningEffort),
			summary: "auto"
		} } : {},
		store: false,
		stream: true,
		include: ["reasoning.encrypted_content"],
		...options.sessionId !== void 0 ? { prompt_cache_key: String(options.sessionId) } : {},
		...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {}
	};
}
/** Codex wire adapter: one instance serves the `codex` provider route. */
// dsh1c-r169: tool-role messages carry results in DSH 0.2.
function dsh1cCodexMessages(messages) {
	return messages.map((message) => {
		if (message.role !== "tool") return message;
		if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) throw new LlmError("Результат инструмента не содержит toolCallId; повторите ход с корректной историей.", "INVALID_REQUEST");
		return { ...message, role: "user", content: [{ type: "tool-result", toolCallId: message.toolCallId, content: message.content, isError: message.isError }] };
	});
}
var CodexAdapter = class extends LlmAdapter {
	catalog;
	catalogFailures = new Map();
	/** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
	accountCatalogs = /* @__PURE__ */ new Map();
	/** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
	catalogOwner;
	constructor(options) {
		super();
		this.options = options;
		codexClientVersion(options.clientVersion);
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	/** Discovery fetcher: resolves the session through the refresh-aware path. */
	async fetchCatalog(account, signal) {
		const cache = await this.catalogFor(account), generation = cache.generation;
		try {
			const version = this.options.clientVersion ?? await this.options.resolveClientVersion?.();
			signal?.throwIfAborted();
			const models = await fetchCodexModels(await this.options.tokens.session(account, false, void 0, true), this.options.fetchFn, signal, version);
			if (cache.generation === generation) this.catalogFailures.delete(account);
			return models;
		} catch (error) {
			if (cache.generation === generation) this.catalogFailures.set(account, { at: Date.now(), message: "Не удалось обновить каталог аккаунта." });
			throw error;
		}
	}
	/** Login, checkbox changes and explicit refresh retain each account's last success. */
	clearAccountCatalog(account) {
		for (const [key, cache] of this.accountCatalogs) if (account === void 0 || key === account) cache.revalidate();
	}
	async catalogFor(account) {
		const key = account ?? await this.options.tokens.defaultAccount();
		if (key === void 0) return this.catalog;
		let cache = this.accountCatalogs.get(key);
		if (cache === void 0) {
			cache = new ModelCatalogCache(catalogStore(`codex:${key}`));
			this.accountCatalogs.set(key, cache);
		}
		return cache;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "OpenAI (OAuth)"
		};
	}
	providerRetryPolicy(provider) {
		return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `codex: provider "${provider}" retryPolicy`);
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? CODEX_MODALITIES
		}));
	}
	async listModels(provider) {
		const own = await this.listOwnModels(provider);
		const pool = this.options.pool?.();
		if (pool === void 0) return own;
		const extra = await pool.modelsForProvider(provider);
		const seen = new Set(own.map((model) => model.id));
		return [...own, ...extra.filter((model) => !seen.has(model.id))];
	}
	/** The provider's own catalog: union of every account, or one account when named. */
	async listOwnModels(provider, account, signal) {
		if (account === void 0) {
			const accounts = (await this.options.tokens.list()).map((entry) => entry.key);
			if (accounts.length === 0) return [];
			return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal), {
				timeoutMs: this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
				...signal === void 0 ? {} : { signal }
			});
		}
		if (!await this.options.tokens.hasSession(account)) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		const catalog = await this.catalogFor(account);
		try {
			return (await discoverOrRetryAuth((force) => this.options.tokens.session(account, force), catalog, () => catalog.get(() => this.fetchCatalog(account, signal)), true)).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				inputModalities: CODEX_MODALITIES,
				...model.priority === void 0 ? {} : { priority: model.priority }
			}));
		} catch (error) {
			if (isDiscoveryAborted(error, signal)) throw error;
			if (isMissingOrInvalidCredential(error)) return [];
			this.options.onWarn?.("codex model discovery failed; retaining last-known metadata when available");
			const known = catalog.lastKnown();
			return known === void 0 ? this.staticModels(provider) : known.map(model => ({ provider, id: model.id, name: model.name, inputModalities: CODEX_MODALITIES }));
		}
	}
	async refreshModels(provider = "codex") {
		return Promise.all((await this.options.tokens.list(true)).map(async ({ key, session }) => {
			if (session.requiresLogin) return { account: key, ok: false };
			const cache = await this.catalogFor(key);
			await cache.ensureSeeded();
			try {
				await withTimeout(signal => discoverOrRetryAuth(force => this.options.tokens.session(key, force, void 0, true), cache, () => cache.refresh(() => this.fetchCatalog(key, signal)), true), this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
				return { account: key, ok: true };
			} catch { return { account: key, ok: false }; }
		}));
	}
	async accountCatalogViews(provider) {
		return Promise.all((await this.options.tokens.list(true)).map(async ({ key, session }, index) => {
			const cache = await this.catalogFor(key);
			await cache.ensureSeeded();
			const failure = this.catalogFailures.get(key), known = cache.lastKnown();
			const status = session.requiresLogin ? "auth-error" : session.enabled === false ? "disabled" : !this.options.discovery ? "configured" : failure ? known === void 0 ? "error" : "stale" : known === void 0 ? "unknown" : "ready";
			return { account: key, name: accountOf(provider, session) ?? key, isDefault: index === 0, enabled: session.enabled !== false,
				status, source: known === void 0 ? this.options.discovery ? "builtin" : "configured" : "account", at: cache.entry?.at, attemptedAt: failure?.at ?? cache.entry?.at,
				models: (known ?? []).map(({ id, name }) => ({ id, name })),
				message: session.requiresLogin ? "Требуется повторный вход." : failure ? known === void 0 ? "Каталог аккаунта не получен. Встроенный список DSH не подтверждает доступ этой подписки." : "Не удалось обновить каталог. Сохранён прежний список; запросы к известным моделям разрешены." : !this.options.discovery ? "Используется настроенный список DSH; каталог аккаунта не запрашивался." : known === void 0 ? "Каталог аккаунта ещё не получен." : void 0 };
		}));
	}

	/**
	* The discovered entry for one model. Resolved through the cache's
	* stale-while-revalidate path so capability metadata stays stable across a
	* long conversation: a discovered-only effort (one missing from the static
	* CODEX_EFFORTS list) selected by the user must not vanish — and fail the
	* call — just because the TTL lapsed mid-turn.
	*/
	async discovered(model, account) {
		if (!this.options.discovery) return void 0;
		return discoverAcrossAccounts(account === void 0 ? (await this.options.tokens.list()).map((entry) => entry.key) : [account], async (account$1) => {
			return (await (await this.catalogFor(account$1)).resolve(() => this.fetchCatalog(account$1)))?.find((entry) => entry.id === model);
		});
	}
	/** Whether the discovered catalog advertises a fast tier for this model. */
	async supportsFastTier(model) {
		return (await this.discovered(model))?.fastTier === true;
	}
	/** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
	async fastCapableModels() {
		if (!this.options.discovery) return [];
		const accounts = (await this.options.tokens.list()).map((entry) => entry.key);
		if (accounts.length === 0) return [];
		const seen = /* @__PURE__ */ new Set();
		const ids = [];
		for (const account of accounts) try {
			const models = await (await this.catalogFor(account)).resolve(() => this.fetchCatalog(account));
			for (const model of models ?? []) {
				if (model.fastTier !== true || seen.has(model.id)) continue;
				seen.add(model.id);
				ids.push(model.id);
			}
		} catch {}
		return ids;
	}
	async resolveModel(provider, model) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(provider, model)) return pool.resolveModel(provider, model);
		return this.resolveOwnModel(provider, model);
	}
	/** Capability resolution of the provider's own models (the pool resolves members here). */
	async resolveOwnModel(provider, model, account) {
		const discovered = await this.discovered(model, account);
		const configured = this.options.models.find((entry) => entry.id === model);
		const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning ?? {
			efforts: CODEX_EFFORTS,
			defaultEffort: CODEX_DEFAULT_EFFORT
		}, { extendable: discovered?.reasoning === void 0 });
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: configured?.inputModalities ?? CODEX_MODALITIES,
			context: { contextWindow: (await this.contextLimits(model, account)).default, maxContextWindow: (await this.contextLimits(model, account)).max },
            speedTiers: await this.supportsFastTier(model) ? ["standard", "fast"] : ["standard"],
			defaultMaxTokens: configured?.maxTokens ?? CODEX_DEFAULT_MAX_TOKENS,
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	/** Account-specific bounds; absent maximum conservatively keeps the advertised default. */
	async contextLimits(model, account) {
		const discovered = await this.discovered(model, account);
		const configured = this.options.models.find((entry) => entry.id === model);
		const fallback = discovered?.contextWindow ?? configured?.contextWindow ?? CODEX_CONTEXT_WINDOW;
		return {
			default: fallback,
			max: discovered?.maxContextWindow ?? fallback
		};
	}
	async contextWindowFor(model, account) {
		const limits = await this.contextLimits(model, account);
		return Math.min(this.options.contextWindowOf?.(model) ?? limits.default, limits.max);
	}
	async *stream(options) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(options.provider, options.model)) {
			yield* pool.stream(options);
			return;
		}
		yield* this.streamCore(options);
	}
	/** Pool seam: stream through one specific account instead of the default. */
	streamAccount(options, account) {
		return this.streamCore(options, account);
	}
	async *streamCore(options, account) {
		account ??= await this.options.tokens.defaultAccount();
		if (account === void 0) throw this.options.tokens.missingCredential();
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		let release;
		try {
			release = this.options.tokens.beginUse(account);
			let session = await this.options.tokens.session(account);
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) {
				session = await this.options.tokens.session(account, true, session.accessToken, true);
				response = await this.request(options, session, watchdog.signal);
			}
			if (!response.ok) throw await httpLlmError(response, "codex API", {
				rateLimitReset: codexRateLimitReset,
				...this.options.onWarn === void 0 ? {} : { onWarn: this.options.onWarn }
			});
			if (response.body === null) throw new LlmError("codex API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamResponses(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("codex API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
			release?.();
		}
	}
	async request(options, session, signal) {
		const messages = await resolveImages(dsh1cCodexMessages(options.messages), this.options.resolveAttachments?.(), signal);
		const requestedTier = options.modelParameters?.speedTier;
        if (requestedTier === "fast" && !await this.supportsFastTier(options.model)) throw new LlmError("This model does not advertise fast speed", "INVALID_REQUEST");
        const fast = options.modelParameters !== void 0 ? requestedTier === "fast" : this.options.speedFor !== void 0 && await this.options.speedFor(options.sessionId, options.model);
		const body = codexRequestBody(options, toResponsesInput(messages, options.system), fast);
		return proxiedFetch(CODEX_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"chatgpt-account-id": session.accountId,
				"originator": "codex_cli_rs",
				"session-id": deterministicSessionId(options.sessionId),
				"accept": "text/event-stream",
				"content-type": "application/json",
				...attributionHeaders()
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion
//#region src/providers/codex-client-version.ts
/** Public metadata only: never send subscription credentials to this endpoint. */
const CODEX_VERSION_URL = "https://registry.npmjs.org/@openai%2fcodex/latest";
/** Lazy, shared-per-plugin lookup of the official CLI's stable version. */
var CodexClientVersionCache = class {
	version = CODEX_CLIENT_VERSION;
	expiresAt = 0;
	pending;
	constructor(fetchFn = proxiedFetch, now = Date.now, timeoutMs = 1500) {
		this.fetchFn = fetchFn;
		this.now = now;
		this.timeoutMs = timeoutMs;
	}
	/** A manual catalog refresh also checks for a newly released CLI. */
	invalidate() {
		this.expiresAt = 0;
	}
	resolve() {
		if (this.pending !== void 0) return this.pending;
		if (this.now() < this.expiresAt) return Promise.resolve(this.version);
		this.pending = this.refresh().finally(() => {
			this.pending = void 0;
		});
		return this.pending;
	}
	async refresh() {
		const controller = new AbortController();
		let timer;
		try {
			const lookup = async () => {
				const response = await this.fetchFn(CODEX_VERSION_URL, {
					headers: { accept: "application/json" },
					redirect: "error",
					signal: controller.signal
				});
				if (!response.ok) throw new Error("Codex version lookup failed");
				const version = (await response.json())?.version;
				if (typeof version !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) throw new Error("Invalid stable Codex version");
				const next = version.split(".").map(Number);
				const previous = this.version.split(".").map(Number);
				const different = next.findIndex((part, index) => part !== previous[index]);
				if (different !== -1 && next[different] < previous[different]) throw new Error("Older Codex version");
				return version;
			};
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(/* @__PURE__ */ new Error("Codex version lookup timed out"));
				}, this.timeoutMs);
			});
			this.version = await Promise.race([lookup(), timeout]);
			this.expiresAt = this.now() + 360 * 6e4;
		} catch {
			this.expiresAt = this.now() + 5 * 6e4;
		} finally {
			clearTimeout(timer);
		}
		return this.version;
	}
};

//#endregion
//#region src/providers/pool-family.ts
/** Map key for one provider's pool of one model (ids collide across providers). */
function poolKey(provider, model) {
	return `${provider}/${model}`;
}
/**
* Build per-provider account routes. Each model id becomes a definition of
* the accounts that list it: two or more fail over; one is pinned to that
* account (so a Max-only model is never sent to a Plus login). The picker
* unions these catalogs; a logout that drops a model to one account keeps
* the same id and pins it to whoever remains.
* @param sources - per-account catalogs (providers with no accounts list
*   nothing and simply never join a pool).
* @returns `provider/model` → pool definition (not listed as an extra entry).
*/
function buildAccountPools(sources) {
	const pools = /* @__PURE__ */ new Map();
	for (const [provider, source] of Object.entries(sources)) {
		const byModel = /* @__PURE__ */ new Map();
		for (const catalog of source.catalogs) for (const model of catalog.models) {
			let entry = byModel.get(model.id);
			if (entry === void 0) {
				entry = {
					members: [],
					info: model
				};
				byModel.set(model.id, entry);
			}
			entry.members.push({
				provider,
				account: catalog.account,
				model: model.id
			});
		}
		for (const [id, { members, info }] of byModel) pools.set(poolKey(provider, id), {
			members,
			...info.name === void 0 || info.name === id ? {} : { name: info.name },
			...info.description === void 0 ? {} : { description: info.description }
		});
	}
	return pools;
}

//#endregion
//#region src/providers/pool-health.ts
/** Registry key for one pool member. */
function memberKey(provider, account, model) {
	return `${provider}/${account}/${model}`;
}
/** Registry key parking EVERY member of one account (account-level failures). */
function accountKey(provider, account) {
	return `${provider}/${account}/*`;
}
/** Default cooldown when a quota/rate failure carries no `retry-after`. */
const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 6e4;
/** Auth failures recheck after a day; a re-login clears the record immediately. */
const AUTH_COOLDOWN_MS = 1440 * 6e4;
/** Transient server-side failures cool down briefly. */
const TRANSIENT_COOLDOWN_MS = 6e4;
/**
* Providers whose quota windows are model-scoped, so a quota failure on one
* model says nothing about its siblings (Claude's Opus/Sonnet lanes). Every
* other provider meters the account as a whole: one member hitting the wall
* means its siblings on the SAME account would too, so the cooldown parks
* the account (other accounts of the provider are unaffected).
*/
const MODEL_SCOPED_QUOTA_PROVIDERS = new Set(["claude"]);
/** The `retry-after` an adapter propagated through `httpLlmError`, when any. */
function retryAfterMs(error) {
	return error.failure.providerRetryAfterMs;
}
/**
* Classify a member failure. Quota and rate-limit failures cool down (using
* the provider's own `retry-after` when sent, which is more accurate than
* any fixed guess) — account-wide for account-metered providers, per-member
* for model-scoped ones; auth failures park the account until re-login
* (credentials are account-level); server/timeout failures get a short
* per-member cooldown; transport failures switch without a record;
* everything else — most importantly CONTEXT_WINDOW_EXCEEDED and ABORTED —
* is the request's own fault and is rethrown untouched.
* @param error - the failure thrown by a member adapter's stream.
* @param provider - the failing member's provider (decides the quota scope).
* @returns the action the pool should take.
*/
function classifyPoolFailure(error, provider) {
	if (!(error instanceof LlmError)) return { action: "throw" };
	switch (error.code) {
		case QUOTA_EXCEEDED_CODE:
		case "RATE_LIMIT": return {
			action: "switch",
			cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS,
			reason: error.code,
			scope: MODEL_SCOPED_QUOTA_PROVIDERS.has(provider) ? "member" : "account"
		};
		case "AUTH":
		case "INVALID_CREDENTIAL":
		case "MISSING_CREDENTIAL": return {
			action: "switch",
			cooldownMs: AUTH_COOLDOWN_MS,
			reason: error.code,
			scope: "account"
		};
		case "SERVER":
		case "TIMEOUT":
		case "EMPTY_RESPONSE": return {
			action: "switch",
			cooldownMs: TRANSIENT_COOLDOWN_MS,
			reason: error.code,
			scope: "member"
		};
		case "TRANSPORT": return { action: "switch" };
		case "HTTP_402":
		case "HTTP_404": return {
			action: "switch",
			cooldownMs: TRANSIENT_COOLDOWN_MS,
			reason: error.code,
			scope: "member"
		};
		case CONTEXT_WINDOW_EXCEEDED_CODE:
		case "ABORTED":
		default: return { action: "throw" };
	}
}
/**
* Cooldown registry keyed by {@link memberKey}. A member whose cooldown has
* expired is simply available again — recovery is proven by the next real
* request, not by a background probe.
*/
var PoolHealthRegistry = class {
	records = /* @__PURE__ */ new Map();
	/** Whether a member may serve: neither it nor its whole account is cooling. */
	isMemberAvailable(provider, account, model, now = Date.now()) {
		return this.isAvailable(accountKey(provider, account), now) && this.isAvailable(memberKey(provider, account, model), now);
	}
	/** Whether one registry key is clear right now. */
	isAvailable(key, now = Date.now()) {
		const record = this.records.get(key);
		if (record === void 0) return true;
		if (record.unavailableUntil <= now) {
			this.records.delete(key);
			return true;
		}
		return false;
	}
	/** Park a member for `cooldownMs`; a longer existing cooldown wins. */
	markUnavailable(key, cooldownMs, reason, now = Date.now()) {
		const until = now + cooldownMs;
		const existing = this.records.get(key);
		if (existing !== void 0 && existing.unavailableUntil > until) return;
		this.records.set(key, {
			unavailableUntil: until,
			reason
		});
	}
	/**
	* Epoch ms at which the earliest cooling record among `keys` recovers;
	* `undefined` when none of them is cooling. The registry is shared by
	* every pool, so the caller passes the keys of ITS members (member and
	* account keys alike) — an unrelated pool's cooldown must not shape this
	* pool's retry hint. Feeds the pool-exhausted error's
	* `providerRetryAfterMs`.
	*/
	earliestRecovery(keys, now = Date.now()) {
		let earliest;
		for (const [key, record] of this.records) {
			if (record.unavailableUntil <= now) {
				this.records.delete(key);
				continue;
			}
			if (!keys.has(key)) continue;
			if (earliest === void 0 || record.unavailableUntil < earliest) earliest = record.unavailableUntil;
		}
		return earliest;
	}
	/** Drop records of one provider, or of a single account when given (auth changes). */
	clear(provider, account) {
		const prefix = account === void 0 ? `${provider}/` : `${provider}/${account}/`;
		for (const key of [...this.records.keys()]) if (key.startsWith(prefix)) this.records.delete(key);
	}
};

//#endregion
//#region src/providers/pool.ts
/** Bound on sticky-session memory; oldest entries evict past it. */
const STICKY_SESSION_LIMIT = 1e3;
/** Display form of one member (account shown when pinned). */
function memberLabel(member) {
	return member.account === void 0 ? `${member.provider}/${member.model}` : `${member.provider}/${member.account}/${member.model}`;
}
/** How long a pools snapshot is trusted (auth changes invalidate immediately). */
const POOLS_CACHE_TTL_MS = 5e3;
var PoolAdapter = class extends LlmAdapter {
	/** sessionId|poolId → member key of the last member that served a chunk. */
	sticky = /* @__PURE__ */ new Map();
	/** Messages already warned about — configuration diagnostics repeat every request otherwise. */
	warned = /* @__PURE__ */ new Set();
	/**
	* Short-lived pools snapshot. `owns()` runs on every resolveModel — the
	* model picker issues one per entry — and pool assembly touches every
	* provider's catalog and account store, so recompute at most this often.
	* Auth changes bump {@link generation} so a stale snapshot cannot land.
	*/
	poolsCache;
	poolsInflight;
	generation = 0;
	constructor(options) {
		super();
		this.options = options;
	}
	/** Drop the pools snapshot so the next read reflects the current accounts. */
	invalidate() {
		this.generation += 1;
		this.poolsCache = void 0;
		this.poolsInflight = void 0;
	}
	/** Warn once per distinct message (pools() runs on every request). */
	warnOnce(message) {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		this.options.onWarn(message);
	}
	/** Drop members whose adapter is not registered (copy — caller state is shared). */
	usable(pools) {
		const result = new Map(pools);
		for (const [id, definition] of [...result]) {
			const kept = definition.members.filter((member) => this.options.adapters[member.provider] !== void 0);
			if (kept.length === 0) result.delete(id);
			else if (kept.length < definition.members.length) result.set(id, {
				...definition,
				members: kept
			});
		}
		return result;
	}
	/** Account pools (auto-aggregated plus config overrides) with usable members. */
	async familyPools() {
		return this.usable(new Map(await this.options.families()));
	}
	/** All pools (account pools merged with extra tiers) with usable members. */
	async pools() {
		const cached = this.poolsCache;
		if (cached !== void 0 && Date.now() - cached.at < POOLS_CACHE_TTL_MS) return cached.pools;
		const gen = this.generation;
		this.poolsInflight ??= this.assemblePools().then((pools) => {
			if (this.generation === gen) this.poolsCache = {
				at: Date.now(),
				pools
			};
			return pools;
		}).finally(() => {
			this.poolsInflight = void 0;
		});
		return this.poolsInflight;
	}
	/** Recompute the pools snapshot (account pools merged with extra tiers). */
	async assemblePools() {
		const pools = await this.familyPools();
		for (const [id, members] of Object.entries(this.options.tiers)) {
			if (members.length === 0) continue;
			const owner = members[0].provider;
			const key = poolKey(owner, id);
			if (pools.has(key)) this.warnOnce(`tier pool "${id}" overrides the account pool of the same id under ${owner}`);
			pools.set(key, {
				members,
				extra: true
			});
		}
		return this.usable(pools);
	}
	/**
	* Extra picker rows one provider lists (configured tiers). Account pools
	* reuse the catalog entry of the same wire id, so they are not listed
	* again — the picker stays one row per model in ChatGPT / Claude / ….
	*/
	async modelsForProvider(provider) {
		const pools = await this.pools();
		const models = [];
		for (const [key, definition] of pools) {
			if (definition.extra !== true) continue;
			if (!key.startsWith(`${provider}/`)) continue;
			const id = key.slice(provider.length + 1);
			models.push({
				provider,
				id,
				name: definition.name ?? id,
				...definition.description === void 0 ? {} : { description: definition.description }
			});
		}
		return models;
	}
	/**
	* Whether `model` on `provider`'s route is served here (several accounts
	* fail over, one account is pinned, or a configured tier).
	*/
	async owns(provider, model) {
		return (await this.pools()).has(poolKey(provider, model));
	}
	/**
	* Resolve every member's account (config members may omit it to mean "the
	* default account") and drop members with no resolvable login. Duplicates
	* collapse — an explicitly pinned account and the default may coincide.
	*/
	async concrete(members) {
		const seen = /* @__PURE__ */ new Set();
		const resolved = [];
		for (const member of members) {
			const account = member.account ?? await this.options.defaultAccount(member.provider);
			if (account === void 0) continue;
			const key = memberKey(member.provider, account, member.model);
			if (seen.has(key)) continue;
			seen.add(key);
			resolved.push({
				provider: member.provider,
				account,
				model: member.model
			});
		}
		return resolved;
	}
	/**
	* Resolve a pool model to the conservative INTERSECTION of its members'
	* capabilities: the smallest context window and output cap, the reasoning
	* efforts every member supports, and the modalities all of them accept —
	* so a request valid for the pool stays valid after a failover. Capability
	* metadata is account-specific, so every distinct member is resolved.
	*/
	async resolveModel(provider, model) {
		const definition = (await this.pools()).get(poolKey(provider, model));
		if (definition === void 0) throw new LlmError(`unknown pool model "${model}"`, "NO_ADAPTER");
		const resolved = [];
		let lastFailure;
		const seenMembers = /* @__PURE__ */ new Set();
		for (const member of definition.members) {
			const identity = JSON.stringify([
				member.provider,
				member.model,
				member.account
			]);
			if (seenMembers.has(identity)) continue;
			seenMembers.add(identity);
			const adapter = this.options.adapters[member.provider];
			if (adapter === void 0) continue;
			try {
				resolved.push(await adapter.resolveOwnModel(member.provider, member.model, member.account));
			} catch (error) {
				lastFailure = error;
				this.warnOnce(`pool "${model}": member ${memberLabel(member)} failed to resolve (${error instanceof Error ? error.message : String(error)}); excluding it`);
			}
		}
		if (resolved.length === 0) throw new LlmError(`pool "${model}" has no usable member`, "NO_ADAPTER", { ...lastFailure === void 0 ? {} : { cause: lastFailure } });
		const contextWindows = resolved.map((info) => info.context?.contextWindow).filter(isNumber);
		const maxContexts = resolved.map(info => info.context?.maxContextWindow ?? info.context?.contextWindow).filter(isNumber);
        const speedTiers = resolved.every(info => info.speedTiers?.length) ? resolved[0].speedTiers.filter(tier => resolved.every(info => info.speedTiers.includes(tier))) : [];
        const maxTokens = resolved.map((info) => info.defaultMaxTokens).filter(isNumber);
		const reasoning = intersectReasoning(resolved);
		const modalities = intersectModalities(resolved);
		return {
			provider,
			id: model,
			name: definition.name ?? model,
			...definition.description === void 0 ? {} : { description: definition.description },
			...contextWindows.length > 0 ? { context: { contextWindow: Math.min(...contextWindows), maxContextWindow: Math.min(...maxContexts) } } : {},
            ...speedTiers.length ? { speedTiers } : {},
			...maxTokens.length > 0 ? { defaultMaxTokens: Math.min(...maxTokens) } : {},
			...reasoning === void 0 ? {} : { reasoning },
			...modalities === void 0 ? {} : { inputModalities: modalities }
		};
	}
	async *stream(options) {
		const definition = (await this.pools()).get(poolKey(options.provider, options.model));
		if (definition === void 0) throw new LlmError(`unknown pool model "${options.model}"`, "NO_ADAPTER");
		const members = await this.concrete(definition.members);
		const candidates = await this.select(options.model, members, options.sessionId);
		if (candidates.length === 0) throw this.exhausted(options.model, members);
		let lastError;
		for (const member of candidates) {
			const adapter = this.options.adapters[member.provider];
			if (adapter === void 0) continue;
			const iterator = adapter.streamAccount({
				...options,
				provider: member.provider,
				model: member.model
			}, member.account)[Symbol.asyncIterator]();
			let first;
			try {
				first = await iterator.next();
				if (first.done === true) throw new LlmError(`${memberLabel(member)} returned an empty stream`, EMPTY_RESPONSE_CODE);
			} catch (error) {
				const classification = classifyPoolFailure(error, member.provider);
				if (classification.action === "throw") throw error;
				if ("cooldownMs" in classification) {
					this.options.health.markUnavailable(classification.scope === "account" ? accountKey(member.provider, member.account) : memberKey(member.provider, member.account, member.model), classification.cooldownMs, classification.reason);
					if (classification.reason === QUOTA_EXCEEDED_CODE || classification.reason === "RATE_LIMIT") this.options.usage.invalidate(member.provider, member.account);
				}
				this.options.onWarn(`pool "${options.model}": ${memberLabel(member)} failed before any output (${error instanceof Error ? error.message : String(error)}); trying the next member`);
				lastError = error;
				continue;
			}
			this.remember(options.model, options.sessionId, member);
			try {
				yield first.value;
				for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) yield next.value;
			} finally {
				try {
					await iterator.return?.();
				} catch {}
			}
			return;
		}
		throw this.exhausted(options.model, members, lastError);
	}
	/**
	* Order the candidates for one request. Health filters both strategies;
	* `quota_aware` then ranks by urgency (members without telemetry, e.g.
	* copilot, score zero and sink to the bottom of their class), while
	* quota-exhausted members stay as a last-resort tail in pool order. The
	* sticky member keeps its lead unless a challenger out-scores it by
	* `switchMargin`.
	*/
	async select(poolId, members, sessionId) {
		const usable = members.filter((member) => this.options.adapters[member.provider] !== void 0 && this.options.health.isMemberAvailable(member.provider, member.account, member.model));
		if (usable.length === 0) return [];
		const stickyMember = sessionId === void 0 ? void 0 : usable.find((member) => memberKey(member.provider, member.account, member.model) === this.sticky.get(stickyKey(poolId, sessionId)));
		if (this.options.strategy === "priority") return stickyMember === void 0 ? usable : [stickyMember, ...usable.filter((member) => member !== stickyMember)];
		const quotas = new Map(await Promise.all(usable.map(async (member) => [member, await this.options.usage.quotaFor(member)])));
		const scored = usable.filter((member) => quotas.get(member)?.available === true);
		const quotaFull = usable.filter((member) => quotas.get(member)?.available === false);
		scored.sort((a, b) => (quotas.get(b)?.urgency ?? 0) - (quotas.get(a)?.urgency ?? 0));
		if (stickyMember !== void 0 && scored.includes(stickyMember)) {
			const best = scored[0];
			const stickyUrgency = quotas.get(stickyMember)?.urgency ?? 0;
			const bestUrgency = quotas.get(best)?.urgency ?? 0;
			if (best === stickyMember || bestUrgency <= stickyUrgency * this.options.switchMargin) {
				scored.splice(scored.indexOf(stickyMember), 1);
				scored.unshift(stickyMember);
			}
		}
		return [...scored, ...quotaFull];
	}
	/** Pin the serving member to the session (with bounded memory). */
	remember(poolId, sessionId, member) {
		if (sessionId === void 0) return;
		const key = stickyKey(poolId, sessionId);
		this.sticky.delete(key);
		if (this.sticky.size >= STICKY_SESSION_LIMIT) {
			const oldest = this.sticky.keys().next();
			if (oldest.done !== true) this.sticky.delete(oldest.value);
		}
		this.sticky.set(key, memberKey(member.provider, member.account, member.model));
	}
	/**
	* The error for an exhausted pool, carrying the earliest recovery hint of
	* THIS pool's members (the health registry is shared across pools, so the
	* hint is scoped to the keys this pool can actually recover through).
	*/
	exhausted(model, pool, cause) {
		const keys = /* @__PURE__ */ new Set();
		for (const member of pool) {
			keys.add(memberKey(member.provider, member.account, member.model));
			keys.add(accountKey(member.provider, member.account));
		}
		const recovery = this.options.health.earliestRecovery(keys);
		const retryAfterMs$1 = recovery === void 0 ? void 0 : Math.max(recovery - Date.now(), 1);
		return new LlmError(`pool "${model}" exhausted: every member is unavailable or failed`, "RATE_LIMIT", {
			...retryAfterMs$1 === void 0 ? {} : { providerRetryAfterMs: retryAfterMs$1 },
			...cause === void 0 ? {} : { cause }
		});
	}
};
function stickyKey(poolId, sessionId) {
	return `${String(sessionId)}|${poolId}`;
}
function isNumber(value) {
	return value !== void 0;
}
/** Reasoning efforts every member supports (id intersection, first member's order). */
function intersectReasoning(resolved) {
	const [first, ...rest] = resolved;
	if (first?.reasoning === void 0) return void 0;
	const efforts = first.reasoning.efforts.filter((effort) => rest.every((info) => info.reasoning?.efforts.some((other) => other.id === effort.id) === true));
	if (efforts.length === 0) return void 0;
	const defaultEffort = first.reasoning.defaultEffort !== void 0 && efforts.some((effort) => effort.id === first.reasoning?.defaultEffort) ? first.reasoning.defaultEffort : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
/** Modalities all members accept; undefined when any member leaves it unknown. */
function intersectModalities(resolved) {
	const [first, ...rest] = resolved;
	if (first?.inputModalities === void 0) return void 0;
	const modalities = first.inputModalities.filter((modality) => rest.every((info) => info.inputModalities?.includes(modality) === true));
	return modalities.length === 0 ? void 0 : modalities;
}

//#endregion
//#region src/providers/image-pool.ts
var ImageAccountPool = class {
	health = new PoolHealthRegistry();
	sticky = /* @__PURE__ */ new WeakMap();
	constructor(options = {}) {
		this.options = options;
	}
	/** Login/logout clears cooling image members and stale session affinity. */
	clear(provider, account) {
		this.health.clear(provider, account);
		this.sticky = /* @__PURE__ */ new WeakMap();
	}
	async request(request) {
		const { provider, tokens, signal, owner, send, rateLimitReset } = request;
		signal.throwIfAborted();
		const accounts = await tokens.list();
		if (accounts.length === 0) {
			await tokens.session();
			throw new LlmError("image_generate: no image account is logged in", "MISSING_CREDENTIAL");
		}
		const pooling = this.options.enabled !== false;
		const members = (pooling ? accounts : accounts.slice(0, 1)).map((entry) => entry.key);
		const sticky = pooling && owner !== void 0 ? this.sticky.get(owner)?.get(provider) : void 0;
		const ordered = sticky !== void 0 && members.includes(sticky) ? [sticky, ...members.filter((key) => key !== sticky)] : members;
		let lastError;
		for (const account of ordered) {
			signal.throwIfAborted();
			const key = memberKey(provider, account, "images");
			if (pooling && !this.health.isAvailable(key)) continue;
			let failure$1;
			const release = provider === "codex" ? tokens.beginUse(account) : () => {};
			try {
				let session = await tokens.session(account);
				signal.throwIfAborted();
				let response = await send(session);
				if (response.status === 401) {
					await response.body?.cancel();
					session = await tokens.session(account, true, session.accessToken, true);
					signal.throwIfAborted();
					response = await send(session);
				}
				signal.throwIfAborted();
				if (response.ok) {
					if (pooling && owner !== void 0) {
						let affinity = this.sticky.get(owner);
						if (affinity === void 0) {
							affinity = /* @__PURE__ */ new Map();
							this.sticky.set(owner, affinity);
						}
						affinity.set(provider, account);
					}
					return request.consume === void 0 ? response : await request.consume(response);
				}
				failure$1 = await httpLlmError(response, "image_generate", { rateLimitReset });
				if (![
					401,
					402,
					403,
					404,
					429
				].includes(response.status)) throw failure$1;
			} catch (error) {
				signal.throwIfAborted();
				if (!(error instanceof LlmError) || ![
					"AUTH",
					"INVALID_CREDENTIAL",
					"MISSING_CREDENTIAL",
					"RATE_LIMIT",
					"HTTP_402",
					"HTTP_404"
				].includes(error.code)) throw error;
				failure$1 = error;
			}
			finally { release(); }
			if (!pooling) throw failure$1;
			const delay = failure$1.failure.providerRetryAfterMs ?? (failure$1.code === "RATE_LIMIT" ? DEFAULT_QUOTA_COOLDOWN_MS : [
				"AUTH",
				"INVALID_CREDENTIAL",
				"MISSING_CREDENTIAL"
			].includes(failure$1.code) ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
			this.health.markUnavailable(key, delay, failure$1.code);
			this.options.onWarn?.(`image pool ${provider}: account ${members.indexOf(account) + 1}/${members.length} rejected (${failure$1.code}); checking remaining accounts`);
			lastError = failure$1;
		}
		if (lastError !== void 0) throw lastError;
		const recovery = this.health.earliestRecovery(new Set(members.map((account) => memberKey(provider, account, "images"))));
		throw new LlmError(`image_generate: all ${provider} image accounts are cooling down`, "RATE_LIMIT", { ...recovery === void 0 ? {} : { providerRetryAfterMs: Math.max(0, recovery - Date.now()) } });
	}
};

//#endregion
//#region src/providers/pool-usage.ts
/** A member is taken out of rotation once any window crosses this fill level. */
const QUOTA_FULL_PERCENT = 95;
/** How long a usage snapshot is trusted before a background refresh. */
const USAGE_TTL_MS = 5 * 6e4;
/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS = {
	session: 300 * 6e4,
	weekly: 10080 * 6e4,
	other: 720 * 60 * 6e4
};
/**
* Per-ACCOUNT usage snapshots with in-flight dedupe and
* stale-while-revalidate refresh. Providers without a usage endpoint
* (copilot) resolve no fetcher and score a constant zero urgency — which
* naturally ranks them behind every measured member. Fetchers are resolved
* lazily per (provider, account) so accounts added after startup join
* tracking on their first score.
*/
var PoolUsageTracker = class {
	entries = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	constructor(fetcherFor, ttlMs = USAGE_TTL_MS) {
		this.fetcherFor = fetcherFor;
		this.ttlMs = ttlMs;
	}
	/** Restore an existing durable sample without replacing a live cache entry. */
	restore(provider, account, snapshot, observedAt) {
		const key = `${provider}/${account}`;
		if (snapshot !== void 0 && Number.isFinite(observedAt) && !this.entries.has(key)) this.entries.set(key, { snapshot, at: observedAt });
	}
	/**
	* The quota view of one member. A cold cache awaits the first fetch; a
	* stale one answers immediately while the refresh serves the NEXT call
	* (member selection must never block on the network mid-conversation). A
	* failure still cooling down degrades immediately with no network call.
	*
	* Deliberately does NOT fall back to `lastSnapshot` the way
	* {@link snapshotFor} does: scoring routing decisions off data that is
	* known to be stale-and-unrefreshable risks steering traffic by a urgency
	* number the endpoint itself is no longer vouching for, whereas
	* `snapshotFor`'s stale-display concern (the Settings page, the composer
	* badge) has no such downside — showing an old percentage beats showing
	* nothing.
	* @param member - the pool member to score (account resolved).
	* @returns availability plus the urgency score.
	*/
	async quotaFor(member) {
		const key = `${member.provider}/${member.account}`;
		const fetcher = this.fetcherFor(member.provider, member.account);
		if (fetcher === void 0) return {
			available: true,
			urgency: 0,
			fetchedAt: 0
		};
		const entry = this.entries.get(key);
		if (entry !== void 0) {
			const fresh = Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs);
			if (entry.snapshot !== void 0) {
				if (!fresh) this.refresh(key, fetcher).catch(() => void 0);
				return this.score(member, entry);
			}
			if (fresh) return degradedQuota(entry.error);
		}
		try {
			const snapshot = await this.refresh(key, fetcher);
			return this.score(member, {
				snapshot,
				at: Date.now()
			});
		} catch (error) {
			return degradedQuota(error);
		}
	}
	/**
	* Same cache as {@link quotaFor}, for direct display (the Settings page):
	* the raw snapshot, or the original fetch error, instead of a routing
	* score.
	* @param provider - the account's provider.
	* @param account - the account key.
	* @param force - bypass a fresh cached SNAPSHOT for an honest re-check (the
	*   manual Refresh button). A live failure cooldown is never bypassed —
	*   retrying through it is exactly what turns a 429 into a permanent
	*   lockout, so even a forced call still answers from the negative cache.
	* @returns `{ supported: false }` when the provider has no usage fetcher.
	*/
	async snapshotFor(provider, account, force = false) {
		const fetcher = this.fetcherFor(provider, account);
		if (fetcher === void 0) return { supported: false };
		const key = `${provider}/${account}`;
		const entry = this.entries.get(key);
		if (entry !== void 0 && Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)) if (entry.snapshot !== void 0) {
			if (!force) return entry.snapshot;
		} else if (entry.lastSnapshot !== void 0) return this.staleSnapshot(entry);
		else throw entry.error;
		try {
			return await this.refresh(key, fetcher);
		} catch (error) {
			const failed = this.entries.get(key);
			if (failed?.snapshot === void 0 && failed?.lastSnapshot !== void 0) return this.staleSnapshot(failed);
			throw error;
		}
	}
	staleSnapshot(entry) {
        return { ...entry.lastSnapshot, stale: true, refreshError: "Не удалось обновить лимиты. Показаны последние полученные данные." };
    }
	/** Drop cached snapshots: one account, or a whole provider when `account` is omitted. */
	invalidate(provider, account) {
		if (account !== void 0) {
			this.entries.delete(`${provider}/${account}`);
			return;
		}
		for (const key of [...this.entries.keys()]) if (key.startsWith(`${provider}/`)) this.entries.delete(key);
	}
	/**
	* Run (or join) the single in-flight fetch for one account key, caching
	* either outcome. A missing/invalid credential is deliberately NOT
	* negative-cached: it costs no network round trip (the session lookup
	* fails before the request goes out) and re-checking live means the
	* member rejoins routing the instant its login is fixed, rather than
	* waiting out a stale cooldown.
	*/
	refresh(key, fetcher) {
		let pending = this.inflight.get(key);
		if (pending === void 0) {
			const prior = this.entries.get(key);
			const lastSnapshot = prior?.snapshot ?? prior?.lastSnapshot;
			pending = fetcher().then((snapshot) => {
                snapshot = { ...snapshot, observedAt: Date.now() };
				this.entries.set(key, {
					snapshot,
					at: Date.now()
				});
				return snapshot;
			}, (error) => {
				if (!isMissingOrInvalidCredential(error)) this.entries.set(key, {
					error,
					at: Date.now(),
					cooldownMs: cooldownFor(error, this.ttlMs),
					...lastSnapshot === void 0 ? {} : { lastSnapshot }
				});
				throw error;
			}).finally(() => {
				this.inflight.delete(key);
			});
			this.inflight.set(key, pending);
		}
		return pending;
	}
	/** Score one member against a snapshot's windows. */
	score(member, entry) {
		const windows = (entry.snapshot.windows ?? []).filter((window) => windowApplies(window, member.model));
		let available = true;
		let urgency = 0;
		for (const window of windows) {
			if (window.usedPercent >= QUOTA_FULL_PERCENT) available = false;
			urgency = Math.max(urgency, windowUrgency(window));
		}
		return {
			available,
			urgency,
			fetchedAt: entry.at
		};
	}
};
/**
* The routing view of a fetch failure. Logged out: the member cannot serve
* at all. Any other failure (network, endpoint rate limit) must not block
* routing — the member stays available with a zero score, degrading the
* strategy to plain priority order for it.
*/
function degradedQuota(error) {
	return isMissingOrInvalidCredential(error) ? {
		available: false,
		urgency: 0,
		fetchedAt: 0
	} : {
		available: true,
		urgency: 0,
		fetchedAt: 0
	};
}
/** How long to hold a failure in the negative cache: the endpoint's own `retry-after`, or the default TTL. */
function cooldownFor(error, defaultTtlMs) {
	return error instanceof OAuthEndpointError && error.retryAfterMs !== void 0 ? error.retryAfterMs : defaultTtlMs;
}
/**
* Whether a window constrains this model: unscoped windows always do; a
* model-scoped window (Claude's Opus/Sonnet lanes) applies when its scope
* names the model family.
*/
function windowApplies(window, model) {
	if (window.scope === void 0) return true;
	return model.toLowerCase().includes(window.scope.toLowerCase());
}
/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window, now = Date.now()) {
	return Math.max(0, 1 - window.usedPercent / 100) / (window.resetsAt !== void 0 ? Math.max(window.resetsAt - now, 1) : FALLBACK_HORIZON_MS[window.kind]);
}

//#endregion
//#region src/translate/anthropic.ts
/**
* The Claude Code identity block. The subscription endpoint rejects requests
* that do not present as Claude Code, so this block is REQUIRED as the first
* system entry on every request.
*/
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Tags wrapping a mid-conversation system message where it sits in the history. */
const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
/**
* How far apart consecutive message breakpoints sit, in content blocks.
*
* A breakpoint looks back at most 20 blocks for an entry an earlier request
* wrote, so marks must stay closer than that: one agentic turn can append a
* dozen tool_use/tool_result blocks at once, and a single trailing mark would
* silently fall out of range and rebuild the whole prefix.
*/
const CACHE_BLOCK_STRIDE = 15;
/**
* Message breakpoints per request. Anthropic allows four in total and the
* last `system` block takes the fourth, so three are left for the history —
* enough to tolerate a turn appending roughly {@link CACHE_BLOCK_STRIDE} × 3
* blocks before a read is lost.
*/
const MESSAGE_CACHE_BREAKPOINTS = 3;
/** Preserve native image blocks, retaining the existing text-only wire shape. */
function toolResultContent(block) {
	if (!block.content.some((part) => part.type === "image" && "dataBase64" in part)) return block.content.map((part) => part.type === "text" ? part.text : "").join("");
	const content = [];
	for (const part of block.content) {
		if (part.type === "text" && part.text.length > 0) content.push({
			type: "text",
			text: part.text
		});
		if (part.type === "image" && "dataBase64" in part) content.push({
			type: "image",
			source: {
				type: "base64",
				media_type: part.mediaType,
				data: part.dataBase64
			}
		});
	}
	return content;
}
/** Parse a tool call's raw JSON arguments into Anthropic's object-shaped `input`. */
function parseToolInput(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
		return {};
	} catch {
		return {};
	}
}
/**
* Move a user message's `tool_result` blocks into one contiguous run at the
* front, preserving the relative order of both groups.
*
* Anthropic answers every `tool_use` against the blocks that *lead* the next
* message, so a block of any other kind before or between the results reads
* as a call left unanswered and the request is rejected. The harness merges
* everything queued for one user turn into a single message, and a parallel
* tool batch arrives as one result message per call, so any context spliced
* mid-batch lands between two results. Restoring the run here keeps that
* independent of delivery order. Order *among* the results does not matter.
* @param message - one assembled user message, reordered in place.
*/
function leadWithToolResults(message) {
	const firstOther = message.content.findIndex((block) => block.type !== "tool_result");
	if (firstOther === -1) return;
	if (!message.content.slice(firstOther).some((block) => block.type === "tool_result")) return;
	message.content = [...message.content.filter((block) => block.type === "tool_result"), ...message.content.filter((block) => block.type !== "tool_result")];
}
/**
* Index of the first non-system message; `messages.length` when every message
* is a system one.
*
* A system message before the conversation starts is the operator's opening
* instruction and belongs in the `system` slot. One that arrives later is
* mid-conversation context, and hoisting it into `system` would move bytes in
* front of the whole history — invalidating every cached turn behind it — so
* it stays where it is, as a reminder block in `messages`.
* @param messages - ordered conversation messages.
* @returns the boundary index separating the two.
*/
function conversationStart(messages) {
	const index = messages.findIndex((message) => message.role !== "system");
	return index === -1 ? messages.length : index;
}
/**
* Convert harness messages into Anthropic messages. Consecutive same-role
* messages merge into one message with multiple content blocks; tool results
* arrive as user messages with `tool_result` blocks, which a merged user
* message keeps in one leading run ({@link leadWithToolResults}); system-role
* messages before the conversation starts are handled by
* {@link toAnthropicSystem} and skipped here, while a later one rides in
* place as a user-role `<system-reminder>` block.
* Reasoning blocks are not replayed (v1). Images must arrive pre-resolved
* ({@link TranslatableMessage}); an unresolved ImageBlock is skipped because
* its bytes are unreachable here.
* @param messages - ordered conversation messages with resolved images.
* @returns Anthropic messages in conversation order.
*/
function toAnthropicMessages(messages) {
	const out = [];
	const start = conversationStart(messages);
	for (const [index, message] of messages.entries()) {
		if (message.role === "system" && index < start) continue;
		const role = message.role === "system" ? "user" : message.role;
		const blocks = [];
		for (const block of message.content) switch (block.type) {
			case "text":
				blocks.push({
					type: "text",
					text: message.role === "system" ? `${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}` : block.text
				});
				break;
			case "tool-call":
				blocks.push(role === "assistant" ? {
					type: "tool_use",
					id: String(block.id),
					name: block.name,
					input: parseToolInput(block.arguments)
				} : {
					type: "text",
					text: `[tool call ${block.name}: ${block.arguments}]`
				});
				break;
			case "tool-result":
				blocks.push({
					type: "tool_result",
					tool_use_id: String(block.toolCallId),
					content: toolResultContent(block),
					...block.isError === true ? { is_error: true } : {}
				});
				break;
			case "image":
				if ("dataBase64" in block) blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mediaType,
						data: block.dataBase64
					}
				});
				break;
			default: break;
		}
		if (blocks.length === 0) continue;
		const last = out[out.length - 1];
		if (last !== void 0 && last.role === role) last.content.push(...blocks);
		else out.push({
			role,
			content: blocks
		});
	}
	for (const message of out) if (message.role === "user") leadWithToolResults(message);
	return out;
}
/**
* Mark the conversation's cache breakpoints in place: the last content block,
* then one every {@link CACHE_BLOCK_STRIDE} blocks backwards, {@link
* MESSAGE_CACHE_BREAKPOINTS} in total.
*
* The history is append-only, so the block one request marks last is
* byte-identical in the next — that entry is what the next request reads.
* Marks are counted across the flattened block sequence, not per message,
* because the lookback window Anthropic walks counts blocks the same way.
* @param messages - assembled Anthropic messages, marked in place.
*/
function markMessageCache(messages) {
	const blocks = messages.flatMap((message) => message.content);
	for (let mark = 0; mark < MESSAGE_CACHE_BREAKPOINTS; mark++) {
		const at = blocks.length - 1 - mark * CACHE_BLOCK_STRIDE;
		if (at < 0) return;
		blocks[at].cache_control = { type: "ephemeral" };
	}
}
/**
* Build the Anthropic `system` array: the mandatory Claude Code identity
* block, then the explicit system prompt, then any system-role messages.
* @param system - explicit system prompt, when set.
* @param messages - conversation messages; the system-role text preceding the
* conversation is appended, and a later one is left to {@link toAnthropicMessages}.
* @returns the system content blocks.
*/
function toAnthropicSystem(system, messages) {
	const blocks = [{
		type: "text",
		text: CLAUDE_CODE_IDENTITY
	}];
	if (system !== void 0 && system.length > 0) blocks.push({
		type: "text",
		text: system
	});
	const history = messages ?? [];
	for (const message of history.slice(0, conversationStart(history))) for (const block of message.content) if (block.type === "text") blocks.push({
		type: "text",
		text: block.text
	});
	blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
	return blocks;
}
/**
* Map harness tool schemas to Anthropic tools, in name order.
*
* `tools` renders at position 0 of the cached prefix, so any reordering
* invalidates every cache entry behind it — `system` and the whole
* conversation included. Registration order belongs to the caller and plugin
* load order can differ between processes, so the wire order is fixed here
* instead. Anthropic selects a tool by name; the array order carries nothing.
* @param tools - tool schemas from the request.
* @returns Anthropic `tools` array entries, ordered by tool name.
*/
function toAnthropicTools(tools) {
	return [...tools].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0).map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters
	}));
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock$1(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Classify an Anthropic `error` event into a thrown LlmError.
* @param error - the wire error object.
* @returns the mapped error.
*/
function anthropicFailure(error) {
	const type = error?.type ?? "unknown_error";
	const message = error?.message ?? `Anthropic reported ${type}`;
	if (type === "invalid_request_error" && /prompt is too long/i.test(message)) return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE);
	if (type === "rate_limit_error") return new LlmError(message, "RATE_LIMIT");
	if (type === "authentication_error") return new LlmError(message, "AUTH");
	return new LlmError(message, "SERVER");
}
/**
* Push-model Anthropic SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes
* are allocated in first-seen order; `usage` is emitted before the terminal
* `finish`, and nothing is emitted after it. `error` events throw
* {@link LlmError}.
*/
var AnthropicStreamTranslator = class {
	blocks = /* @__PURE__ */ new Map();
	nextIndex = 0;
	sawAnyBlock = false;
	pendingUsage;
	outputTokens;
	stopReason = "stop";
	usageEmitted = false;
	/** Set once `message_stop` produced the terminal finish chunk. */
	terminated = false;
	open(wireIndex, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(wireIndex, block);
		this.sawAnyBlock = true;
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	emitUsage(chunks) {
		if (this.usageEmitted) return;
		this.usageEmitted = true;
		const usage = {
			inputTokens: this.pendingUsage?.inputTokens ?? 0,
			outputTokens: this.outputTokens ?? 0,
			...this.pendingUsage?.cacheReadTokens !== void 0 ? { cacheReadTokens: this.pendingUsage.cacheReadTokens } : {},
			...this.pendingUsage?.cacheWriteTokens !== void 0 ? { cacheWriteTokens: this.pendingUsage.cacheWriteTokens } : {}
		};
		chunks.push({
			type: "usage",
			usage
		});
	}
	/**
	* Process one parsed Anthropic SSE event.
	* @param event - the parsed event object.
	* @returns the StreamChunks this event produced (possibly none).
	*/
	push(event) {
		if (this.terminated) return [];
		const chunks = [];
		switch (event.type) {
			case "message_start": {
				const usage = event.message?.usage;
				if (usage !== void 0) {
					this.pendingUsage = {
						inputTokens: usage.input_tokens ?? 0,
						...usage.cache_read_input_tokens !== void 0 ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
						...usage.cache_creation_input_tokens !== void 0 ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}
					};
					this.outputTokens = usage.output_tokens ?? this.outputTokens;
				}
				return chunks;
			}
			case "content_block_start": {
				const wireIndex = event.index ?? 0;
				const block = event.content_block;
				switch (block?.type) {
					case "text":
						this.open(wireIndex, "text", chunks);
						break;
					case "thinking":
						this.open(wireIndex, "reasoning", chunks);
						break;
					case "tool_use": {
						const opened = this.open(wireIndex, "tool-call", chunks, block.id ?? "", block.name);
						chunks.push({
							type: "tool-call-delta",
							index: opened.index,
							id: ToolCallId(opened.callId),
							...block.name === void 0 ? {} : { name: block.name },
							argumentsDelta: ""
						});
						break;
					}
					default: break;
				}
				return chunks;
			}
			case "content_block_delta": {
				const wireIndex = event.index ?? 0;
				const block = this.blocks.get(wireIndex);
				const delta = event.delta;
				if (block === void 0 || delta === void 0) return chunks;
				switch (delta.type) {
					case "text_delta":
						block.text += delta.text ?? "";
						chunks.push({
							type: "text-delta",
							index: block.index,
							text: delta.text ?? ""
						});
						break;
					case "thinking_delta":
						block.text += delta.thinking ?? "";
						chunks.push({
							type: "reasoning-delta",
							index: block.index,
							text: delta.thinking ?? ""
						});
						break;
					case "input_json_delta":
						block.text += delta.partial_json ?? "";
						chunks.push({
							type: "tool-call-delta",
							index: block.index,
							id: ToolCallId(block.callId),
							...block.name === void 0 ? {} : { name: block.name },
							argumentsDelta: delta.partial_json ?? ""
						});
						break;
					default: break;
				}
				return chunks;
			}
			case "content_block_stop": {
				const wireIndex = event.index ?? 0;
				const block = this.blocks.get(wireIndex);
				if (block === void 0) return chunks;
				this.blocks.delete(wireIndex);
				chunks.push({
					type: "block-end",
					index: block.index,
					block: closeBlock$1(block)
				});
				return chunks;
			}
			case "message_delta":
				if (event.usage?.output_tokens !== void 0) this.outputTokens = event.usage.output_tokens;
				switch (event.delta?.stop_reason) {
					case "end_turn":
					case "stop_sequence":
						this.stopReason = "stop";
						break;
					case "tool_use":
						this.stopReason = "tool-calls";
						break;
					case "max_tokens":
						this.stopReason = "max-tokens";
						break;
					default: break;
				}
				return chunks;
			case "message_stop":
				this.terminated = true;
				for (const [wireIndex, block] of [...this.blocks]) {
					this.blocks.delete(wireIndex);
					chunks.push({
						type: "block-end",
						index: block.index,
						block: closeBlock$1(block)
					});
				}
				this.emitUsage(chunks);
				if (this.stopReason === "stop" && !this.sawAnyBlock) chunks.push({
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "model returned a completed response with no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				});
				else chunks.push({
					type: "finish",
					reason: { kind: this.stopReason }
				});
				return chunks;
			case "error": throw anthropicFailure(event.error);
			default: return chunks;
		}
	}
};
/**
* Consume an Anthropic SSE byte stream and yield harness StreamChunks.
* @param stream - raw response body.
* @param onActivity - transport-activity callback for the idle watchdog.
* @returns the chunk stream; throws when the stream ends before `message_stop`.
*/
async function* streamAnthropic(stream, onActivity) {
	const translator = new AnthropicStreamTranslator();
	for await (const sseEvent of parseSse(stream, onActivity)) {
		let event;
		try {
			event = JSON.parse(sseEvent.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		yield* translator.push(event);
		if (translator.terminated) return;
	}
	throw new LlmError("Anthropic SSE stream ended before message_stop", "STREAM_CLOSED");
}

//#endregion
//#region src/providers/claude.ts
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://claude.ai/v1/oauth/token";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages?beta=true";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_CALLBACK_PATH = "/callback";
const CLAUDE_CONTEXT_WINDOW = 2e5;
const CLAUDE_DEFAULT_MAX_TOKENS = 32e3;
/** Refresh when the access token has less than this much life left. */
const CLAUDE_PREEMPT_MS = 5 * 6e4;
/**
* Body fields Anthropic uses to name a reset instant, read when the unified
* headers are absent.
*/
const CLAUDE_RESET_FIELDS = [
	"resets_at",
	"resetsAt",
	"reset_at",
	"retry_after"
];
/**
* Reads the reset instant of the Anthropic window that rejected a request.
*
* `anthropic-ratelimit-unified-*` is the subscription-plan family — the one
* Claude Code renders as "resets 3pm" — and is the only header that names the
* window which actually rejected this request. The per-bucket
* `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`
* headers are deliberately not read: they are rollover snapshots attached to
* every response, so on a 429 they cannot say which bucket refused, and the
* earliest of them is typically the bucket that still had room — a wait that
* lands straight back in the closed window. They reach the operator through
* `rateLimitDiagnostics` instead.
*/
const claudeRateLimitReset = (response, body, now) => {
	const unified = earliestReset(resetInstantFromHeader(response, "anthropic-ratelimit-unified-reset", now), resetInstantFromHeader(response, "anthropic-ratelimit-unified-fallback-reset", now));
	if (unified !== void 0) return unified;
	return resetFromFields(jsonBody(body), CLAUDE_RESET_FIELDS, now);
};
/**
* The subscription endpoint only serves requests presenting as Claude Code,
* so these headers impersonate the CLI; the harness attribution user-agent
* cannot be sent here (one user-agent slot, and the CLI's wins).
*/
const CLAUDE_CLI_FALLBACK_VERSION = "2.1.234";
function detectClaudeVersion() {
	try {
		const match = execFileSync("claude", ["--version"], {
			timeout: 3e3,
			encoding: "utf8"
		}).match(/^(\d+\.\d+\.\d+)/);
		if (match) return match[1];
	} catch {}
	return CLAUDE_CLI_FALLBACK_VERSION;
}
let claudeCliUserAgent;
function getClaudeCliUserAgent() {
	if (claudeCliUserAgent === void 0) claudeCliUserAgent = `claude-cli/${detectClaudeVersion()} (external, cli)`;
	return claudeCliUserAgent;
}
const CLAUDE_BETA_FALLBACK = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"effort-2025-11-24",
	"compact-2026-01-12",
	"files-api-2025-04-14"
].join(",");
const CLAUDE_BETA_FLAGS = CLAUDE_BETA_FALLBACK;
/** Static claude flow facts for the OAuth flow engine. */
const claudeFlow = {
	callbackPath: CLAUDE_CALLBACK_PATH,
	listen: {
		host: "localhost",
		ports: [0]
	},
	buildAuthorizeUrl({ redirectUri, state, pkce }) {
		return `${CLAUDE_AUTHORIZE_URL}?${new URLSearchParams({
			code: "true",
			client_id: CLAUDE_CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: CLAUDE_SCOPE,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			state
		}).toString()}`;
	}
};
/** Best-effort account profile; login must not fail when this does. */
async function fetchClaudeProfile(accessToken) {
	try {
		const response = await proxiedFetch(CLAUDE_PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` } });
		if (!response.ok) return {};
		const profile = await response.json();
		const account = typeof profile.account === "object" && profile.account !== null ? profile.account : {};
		const email = profile.emailAddress ?? profile.email ?? account.email_address ?? account.email;
		const subscription = profile.subscriptionType ?? profile.subscription_type ?? account.subscription_type;
		return {
			...typeof email === "string" && email.length > 0 ? { emailAddress: email } : {},
			...typeof subscription === "string" && subscription.length > 0 ? { subscriptionType: subscription } : {}
		};
	} catch {
		return {};
	}
}
/** Build a session from a token response. */
async function claudeSession(tokens, fallbackRefreshToken, withProfile) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("claude token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
	if (refreshToken === void 0) throw new Error("claude token endpoint returned no refresh token");
	if (typeof tokens.expires_in !== "number" || tokens.expires_in <= 0) throw new Error("claude token endpoint returned no usable expiry");
	const profile = withProfile ? await fetchClaudeProfile(tokens.access_token) : {};
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: Date.now() + tokens.expires_in * 1e3,
		scopes: tokens.scope ?? CLAUDE_SCOPE,
		...profile
	};
}
/**
* Exchange an authorization code for a claude session (JSON grant).
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @param state - the attempt's state (echoed to the token endpoint).
* @returns the session to store.
*/
async function exchangeClaudeCode(code, verifier, redirectUri, state) {
	const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLAUDE_CLIENT_ID,
			code_verifier: verifier,
			state
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "claude");
	return claudeSession(await response.json(), void 0, true);
}
/**
* Refresh a claude session (JSON grant echoing the issued scope).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshClaude(session) {
	const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: session.refreshToken,
			client_id: CLAUDE_CLIENT_ID,
			scope: session.scopes
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "claude");
	return {
		...await claudeSession(await response.json(), session.refreshToken, false),
		...session.emailAddress === void 0 ? {} : { emailAddress: session.emailAddress },
		...session.subscriptionType === void 0 ? {} : { subscriptionType: session.subscriptionType }
	};
}
/**
* Whether a claude refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isClaudePermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && (error.oauthCode === "invalid_grant" || error.oauthCode === "invalid_token");
}
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** RFC3339 `resets_at` value → epoch ms, or undefined when absent/unparsable. */
function claudeResetsAt(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** Map one legacy `{utilization, resets_at}` bucket; undefined when null or unusable. */
function claudeLegacyWindow(value, kind, scope) {
	if (typeof value !== "object" || value === null) return void 0;
	const bucket = value;
	if (typeof bucket.utilization !== "number" || !Number.isFinite(bucket.utilization)) return void 0;
	const resetsAt = claudeResetsAt(bucket.resets_at);
	return {
		kind,
		...scope === void 0 ? {} : { scope },
		usedPercent: bucket.utilization,
		...resetsAt === void 0 ? {} : { resetsAt }
	};
}
/** Map the modern `limits` array; empty when absent or carrying nothing usable. */
function claudeLimitsWindows(value) {
	if (!Array.isArray(value)) return [];
	const windows = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw;
		if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue;
		const kind = entry.kind === "session" ? "session" : entry.kind === "weekly_all" || entry.kind === "weekly_scoped" ? "weekly" : "other";
		const scope = entry.scope?.model?.display_name;
		const resetsAt = claudeResetsAt(entry.resets_at);
		windows.push({
			kind,
			...typeof scope === "string" && scope.length > 0 ? { scope } : {},
			usedPercent: entry.percent,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	}
	return windows;
}
/**
* Fetch the claude subscription usage from the OAuth usage endpoint (the
* source of Claude Code's `/usage` screen). Newer responses carry a
* structured `limits` array; older ones the flat `five_hour`/`seven_day*`
* buckets — both shapes are read, the array winning when it has entries.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchClaudeUsage(session, fetchFn = proxiedFetch, signal) {
	const response = await fetchFn(CLAUDE_USAGE_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			"user-agent": getClaudeCliUserAgent(),
			"accept": "application/json"
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "claude usage");
	const payload = await response.json();
	const modern = claudeLimitsWindows(payload.limits);
	if (modern.length > 0) return {
		supported: true,
		windows: modern
	};
	const windows = [];
	const legacy = [
		claudeLegacyWindow(payload.five_hour, "session"),
		claudeLegacyWindow(payload.seven_day, "weekly"),
		claudeLegacyWindow(payload.seven_day_opus, "weekly", "Opus"),
		claudeLegacyWindow(payload.seven_day_sonnet, "weekly", "Sonnet")
	];
	for (const window of legacy) if (window !== void 0) windows.push(window);
	return {
		supported: true,
		windows
	};
}
function claudeThinkingType(capabilities) {
	const types = capabilities?.thinking?.types;
	if (types?.enabled?.supported === true) return "enabled";
	if (types?.adaptive?.supported === true) return "adaptive";
}
/** Effort levels in display order; a model exposes only the ones it advertises as supported. */
const CLAUDE_EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function claudeReasoning(capabilities) {
	const effort = capabilities?.effort;
	if (effort?.supported !== true) return void 0;
	const efforts = CLAUDE_EFFORT_LEVELS.filter((level) => effort[level]?.supported === true).map((level) => ({
		id: ReasoningEffortId(level),
		name: level[0].toUpperCase() + level.slice(1)
	}));
	return efforts.length > 0 ? { efforts } : void 0;
}
/** Fetch the live model catalog from the subscription endpoint. `signal` cancels the request. */
async function fetchClaudeModels(session, fetchFn = proxiedFetch, signal) {
	const response = await fetchFn(CLAUDE_MODELS_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"anthropic-version": "2023-06-01",
			"user-agent": getClaudeCliUserAgent(),
			"anthropic-dangerous-direct-browser-access": "true",
			"accept": "application/json"
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await httpLlmError(response, "claude models API");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("claude models API returned an invalid catalog");
	const models = payload.data.filter((m) => typeof m.id === "string").map((m) => {
		const thinkingType = claudeThinkingType(m.capabilities);
		const reasoning = claudeReasoning(m.capabilities);
		return {
			id: m.id,
			name: m.display_name ?? m.id,
			...thinkingType === void 0 ? {} : { thinkingType },
			...reasoning === void 0 ? {} : { reasoning }
		};
	});
	if (models.length === 0) throw new Error("claude models API returned an empty catalog");
	return models;
}
/** The Claude 4.5 family accepts image input. */
const CLAUDE_MODALITIES = ["text", "image"];
/**
* Assemble the Anthropic request body.
*
* Extracted from the adapter so the wire shape — cache breakpoints above all —
* is testable without a network round trip. The message array is marked before
* it is placed so the breakpoints land on the blocks the body ships: one on the
* last `system` block (covering `tools` + `system`, which render ahead of it)
* and up to three across the history, Anthropic's four-slot maximum.
* @param options - the generate request.
* @param messages - conversation messages with images already resolved.
* @param maxTokens - the resolved output cap.
* @param thinking - the thinking parameter, when the model takes one.
* @param effort - the reasoning effort, when the model advertises efforts.
* @returns the JSON body to POST.
*/
function claudeRequestBody(options, messages, maxTokens, thinking, effort) {
	const anthropicMessages = toAnthropicMessages(messages);
	markMessageCache(anthropicMessages);
	return {
		model: options.model,
		max_tokens: maxTokens,
		system: toAnthropicSystem(options.system, messages),
		messages: anthropicMessages,
		...options.tools !== void 0 && options.tools.length > 0 ? { tools: toAnthropicTools(options.tools) } : {},
		...thinking === void 0 ? {} : { thinking },
		...effort === void 0 ? {} : { output_config: { effort } },
		stream: true,
		...options.sessionId !== void 0 ? { metadata: { user_id: String(options.sessionId) } } : {}
	};
}
/** Claude wire adapter: one instance serves the `claude` provider route. */
var ClaudeAdapter = class extends LlmAdapter {
	catalog;
	/** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
	accountCatalogs = /* @__PURE__ */ new Map();
	/** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
	catalogOwner;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	async fetchCatalog(account, signal) {
		return fetchClaudeModels(await this.options.tokens.session(account), this.options.fetchFn, signal);
	}
	/** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
	clearAccountCatalog(account) {
		if (account === void 0) this.accountCatalogs.clear();
		else this.accountCatalogs.delete(account);
		if (account === void 0 || this.catalogOwner === account || this.catalogOwner === void 0) {
			this.catalogOwner = void 0;
			this.catalog.invalidate();
		}
	}
	/** Persisted cache for the default account; a throwaway cache for any other. */
	async catalogFor(account) {
		const defaultKey = await this.options.tokens.defaultAccount();
		const key = account ?? defaultKey;
		if (key === void 0 || key === defaultKey) {
			if (this.catalogOwner !== void 0 && this.catalogOwner !== defaultKey) this.catalog.invalidate();
			this.catalogOwner = defaultKey;
			return this.catalog;
		}
		let cache = this.accountCatalogs.get(key);
		if (cache === void 0) {
			cache = new ModelCatalogCache();
			this.accountCatalogs.set(key, cache);
		}
		return cache;
	}
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return discoverAcrossAccounts((await this.options.tokens.list()).map((entry) => entry.key), async (account) => {
			return (await (await this.catalogFor(account)).resolve(() => this.fetchCatalog(account)))?.find((entry) => entry.id === model);
		});
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? CLAUDE_MODALITIES
		}));
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Claude (Subscription)"
		};
	}
	providerRetryPolicy(provider) {
		return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `claude: provider "${provider}" retryPolicy`);
	}
	async listModels(provider) {
		return []; // dsh1c-r112: direct Claude OAuth requires extra usage
		const own = await this.listOwnModels(provider);
		const pool = this.options.pool?.();
		if (pool === void 0) return own;
		const extra = await pool.modelsForProvider(provider);
		const seen = new Set(own.map((model) => model.id));
		return [...own, ...extra.filter((model) => !seen.has(model.id))];
	}
	/** The provider's own catalog: union of every account, or one account when named. */
	async listOwnModels(provider, account, signal) {
		return []; // dsh1c-r112: direct Claude OAuth requires extra usage
		if (account === void 0) {
			const accounts = (await this.options.tokens.list()).map((entry) => entry.key);
			if (accounts.length === 0) return [];
			return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal), {
				timeoutMs: DISCOVERY_TIMEOUT_MS,
				...signal === void 0 ? {} : { signal }
			});
		}
		if (!await this.options.tokens.hasSession(account)) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		const catalog = await this.catalogFor(account);
		try {
			return (await discoverOrRetryAuth((force) => this.options.tokens.session(account, force), catalog, () => catalog.get(() => this.fetchCatalog(account, signal)))).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: CLAUDE_MODALITIES
			}));
		} catch (error) {
			if (isDiscoveryAborted(error, signal)) throw error;
			if (isMissingOrInvalidCredential(error)) return [];
			this.options.onWarn?.(`claude model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	async resolveModel(provider, model) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(provider, model)) return pool.resolveModel(provider, model);
		return this.resolveOwnModel(provider, model);
	}
	/** Capability resolution of the provider's own models (the pool resolves members here). */
	async resolveOwnModel(provider, model) {
		throw new LlmError("Прямой Claude OAuth отключён. Для подписки выберите Claude (OAuth): официальный CLI использует ваш вход. Включённый в аккаунте extra usage оплачивается отдельно от подписки; отключите его в настройках Claude, если дополнительные списания не нужны.", "CLAUDE_MAX_ROUTE_UNAVAILABLE"); // dsh1c-r112
		const disc = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), disc?.reasoning);
		return {
			provider,
			id: model,
			name: disc?.name ?? configured?.name ?? model,
			inputModalities: configured?.inputModalities ?? CLAUDE_MODALITIES,
			context: { contextWindow: disc?.contextWindow ?? configured?.contextWindow ?? CLAUDE_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async *stream(options) {
		throw new LlmError("Прямой Claude OAuth отключён. Для подписки выберите Claude (OAuth): официальный CLI использует ваш вход. Включённый в аккаунте extra usage оплачивается отдельно от подписки; отключите его в настройках Claude, если дополнительные списания не нужны.", "CLAUDE_MAX_ROUTE_UNAVAILABLE"); // dsh1c-r112
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(options.provider, options.model)) {
			yield* pool.stream(options);
			return;
		}
		yield* this.streamCore(options);
	}
	/** Pool seam: stream through one specific account instead of the default. */
	streamAccount(options, account) {
		return this.streamCore(options, account);
	}
	async *streamCore(options, account) {
		throw new LlmError("Прямой Claude OAuth отключён. Для подписки выберите Claude (OAuth): официальный CLI использует ваш вход. Включённый в аккаунте extra usage оплачивается отдельно от подписки; отключите его в настройках Claude, если дополнительные списания не нужны.", "CLAUDE_MAX_ROUTE_UNAVAILABLE"); // dsh1c-r112
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session(account);
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) {
				session = await this.options.tokens.session(account, true);
				response = await this.request(options, session, watchdog.signal);
			}
			if (!response.ok) throw await httpLlmError(response, "claude API", {
				rateLimitReset: claudeRateLimitReset,
				...this.options.onWarn === void 0 ? {} : { onWarn: this.options.onWarn }
			});
			if (response.body === null) throw new LlmError("claude API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamAnthropic(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("claude API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	/**
	* `display: 'summarized'` is set explicitly on both shapes: `adaptive`-type
	* models default to `display: 'omitted'`, which returns thinking blocks with
	* an empty `thinking` field — without this override the "Think" panel would
	* always render empty even though real reasoning (and billed thinking_tokens)
	* ran.
	*/
	thinkingParam(thinkingType, maxTokens) {
		if (thinkingType === "adaptive") return {
			type: "adaptive",
			display: "summarized"
		};
		if (thinkingType === "enabled") {
			const budget = Math.min(Math.max(1024, Math.floor(maxTokens * .5)), maxTokens - 100);
			if (budget < 1024) return void 0;
			return {
				type: "enabled",
				budget_tokens: budget,
				display: "summarized"
			};
		}
	}
	async request(options, session, signal) {
		throw new LlmError("Прямой Claude OAuth отключён. Для подписки выберите Claude (OAuth): официальный CLI использует ваш вход. Включённый в аккаунте extra usage оплачивается отдельно от подписки; отключите его в настройках Claude, если дополнительные списания не нужны.", "CLAUDE_MAX_ROUTE_UNAVAILABLE"); // dsh1c-r112
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const maxTokens = options.maxTokens ?? this.options.models.find((entry) => entry.id === options.model)?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS;
		const disc = await this.discovered(options.model);
		const body = claudeRequestBody(options, messages, maxTokens, this.thinkingParam(disc?.thinkingType, maxTokens), options.reasoningEffort !== void 0 && disc?.reasoning !== void 0 ? String(options.reasoningEffort) : void 0);
		return proxiedFetch(CLAUDE_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": CLAUDE_BETA_FLAGS,
				"user-agent": getClaudeCliUserAgent(),
				"x-app": "cli",
				"anthropic-dangerous-direct-browser-access": "true",
				"accept": "text/event-stream",
				"content-type": "application/json"
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion
//#region src/providers/grok.ts
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const GROK_API_URL = "https://api.x.ai/v1/responses";
const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const GROK_CALLBACK_PATH = "/callback";
const GROK_CONTEXT_WINDOW = 256e3;
const GROK_DEFAULT_MAX_TOKENS = 32e3;
/** Refresh when the access token has less than this much life left. */
const GROK_PREEMPT_MS = 2 * 6e4;
/** Body fields xAI uses to name a delay or reset. */
const GROK_RESET_FIELDS = [
	"retry_after",
	"retry_after_seconds",
	"resets_at",
	"reset_at"
];
/**
* Reads the reset instant of the xAI window that rejected a request.
*
* Body only. xAI serves the OpenAI-compatible `x-ratelimit-reset-*` family,
* whose values are rollover durations (`6m0s`) present on every response, one
* per bucket — on a 429 the earliest of them is usually a bucket with room
* (`0s` for the request bucket while the token bucket is the one exhausted),
* which would burn the whole retry budget in seconds. They reach the operator
* through `rateLimitDiagnostics` instead.
*/
const grokRateLimitReset = (_response, body, now) => resetFromFields(jsonBody(body), GROK_RESET_FIELDS, now);
/** A discovered URL must be https on x.ai or a subdomain; anything else is a hostile document. */
function assertXaiEndpoint(url, field) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`grok OIDC discovery returned an invalid ${field}`);
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "x.ai" && !parsed.hostname.endsWith(".x.ai")) throw new Error(`grok OIDC discovery returned a non-x.ai ${field}: ${url}`);
	return url;
}
let discoveryCache;
/**
* Resolve the xAI OIDC endpoints (cached after the first fetch).
* @returns validated authorization and token endpoints.
*/
async function grokDiscovery() {
	if (discoveryCache !== void 0) return discoveryCache;
	const response = await proxiedFetch(GROK_DISCOVERY_URL);
	if (!response.ok) throw await oauthEndpointError(response, "grok OIDC discovery");
	const document = await response.json();
	if (typeof document.authorization_endpoint !== "string" || typeof document.token_endpoint !== "string") throw new Error("grok OIDC discovery document is missing endpoints");
	discoveryCache = {
		authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, "authorization_endpoint"),
		tokenEndpoint: assertXaiEndpoint(document.token_endpoint, "token_endpoint")
	};
	return discoveryCache;
}
/**
* Build the grok flow facts for the OAuth flow engine (async because the
* authorize URL comes from OIDC discovery).
* @returns the flow spec for one attempt.
*/
async function grokFlow() {
	const discovery = await grokDiscovery();
	return {
		callbackPath: GROK_CALLBACK_PATH,
		listen: {
			host: "127.0.0.1",
			ports: [56121]
		},
		buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
			const params = new URLSearchParams({
				response_type: "code",
				client_id: GROK_CLIENT_ID,
				redirect_uri: redirectUri,
				scope: GROK_SCOPE,
				code_challenge: pkce.challenge,
				code_challenge_method: "S256",
				state,
				nonce,
				plan: "generic",
				referrer: "dsh-plugin-subscriptions"
			});
			return `${discovery.authorizationEndpoint}?${params.toString()}`;
		}
	};
}
/**
* Display names for the numeric `tier` claim xAI stamps on OAuth access
* tokens (the `prod_auth.SubscriptionTier` proto enum; the mapping mirrors
* grok-build's `jwt_tier_claim`). Unknown values fall through to the raw
* number so a future tier still shows something.
*/
const GROK_TIER_NAMES = {
	0: "Free",
	1: "SuperGrok",
	2: "X Basic",
	3: "X Premium",
	4: "X Premium+",
	5: "SuperGrok Heavy",
	6: "SuperGrok Lite",
	7: "SuperGrok Plus"
};
/**
* The subscription tier encoded in a grok access token's `tier` claim (no
* verification — same trust posture as the other claim reads).
* @param accessToken - the stored access token.
* @returns the display tier name, or undefined when the claim is absent.
*/
function grokTierName(accessToken) {
	const tier = decodeJwtPayload(accessToken)?.tier;
	if (typeof tier !== "number" || !Number.isInteger(tier)) return void 0;
	return GROK_TIER_NAMES[tier] ?? String(tier);
}
/** Pick a display account from an id token's claims. */
function grokAccount(idToken) {
	const payload = idToken === void 0 ? void 0 : decodeJwtPayload(idToken);
	const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub;
	return typeof claim === "string" && claim.length > 0 ? claim : void 0;
}
/** Build a session from a token response. */
function grokSession(tokens, tokenEndpoint, fallbackRefreshToken) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("grok token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
	if (refreshToken === void 0) throw new Error("grok token endpoint returned no refresh token");
	if (typeof tokens.expires_in !== "number" || tokens.expires_in <= 0) throw new Error("grok token endpoint returned no usable expiry");
	const account = grokAccount(tokens.id_token);
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: Date.now() + tokens.expires_in * 1e3,
		tokenEndpoint,
		...typeof tokens.scope === "string" ? { scopes: tokens.scope } : {},
		...account === void 0 ? {} : { account }
	};
}
/**
* Exchange an authorization code for a grok session (form-encoded grant that
* echoes the PKCE challenge as well as the verifier, per the xAI flow).
* A 403 here means the X plan lacks the API OAuth entitlement.
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @param challenge - the PKCE challenge sent at authorize time.
* @returns the session to store.
*/
async function exchangeGrokCode(code, verifier, redirectUri, challenge) {
	const discovery = await grokDiscovery();
	const response = await proxiedFetch(discovery.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: GROK_CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			code_challenge: challenge,
			code_challenge_method: "S256"
		}).toString()
	});
	if (response.status === 403) throw new OAuthEndpointError("grok token endpoint refused the exchange (HTTP 403): your X plan does not include the API OAuth entitlement; an X Premium or xAI subscription with API access is required", 403);
	if (!response.ok) throw await oauthEndpointError(response, "grok");
	return grokSession(await response.json(), discovery.tokenEndpoint);
}
/**
* Refresh a grok session (form-encoded grant).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshGrok(session) {
	const response = await proxiedFetch(session.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: GROK_CLIENT_ID,
			refresh_token: session.refreshToken
		}).toString()
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok");
	const next = grokSession(await response.json(), session.tokenEndpoint, session.refreshToken);
	return {
		...next,
		...session.account === void 0 ? {} : { account: session.account },
		...next.scopes === void 0 && session.scopes !== void 0 ? { scopes: session.scopes } : {}
	};
}
/**
* Whether a grok refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isGrokPermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && error.oauthCode === "invalid_grant";
}
/**
* The Grok Build CLI chat proxy's billing endpoint (the source of the CLI's
* `/usage` "Usage limit" panel; see xai-org/grok-build
* `extensions/billing.rs`). Forwards to the backend `GetGrokCreditsConfig`.
*/
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** RFC3339 timestamp → epoch ms, or undefined when absent/unparsable. */
function grokResetsAt(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Fetch the grok subscription usage from the Grok Build CLI chat proxy. The
* newer credits config carries a ready-made percentage plus the current
* (typically weekly) period; the legacy shape carries cent-valued
* `monthlyLimit`/`used`, from which the percentage is derived.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchGrokUsage(session, fetchFn = proxiedFetch, signal) {
	const response = await fetchFn(GROK_BILLING_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"x-xai-token-auth": "xai-grok-cli",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok billing");
	const payload = await response.json();
	const config = typeof payload.config === "object" && payload.config !== null ? payload.config : {};
	const windows = [];
	if (typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent)) {
		const kind = config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : "other";
		const resetsAt = grokResetsAt(config.currentPeriod?.end);
		windows.push({
			kind,
			usedPercent: config.creditUsagePercent,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	} else if (typeof config.monthlyLimit?.val === "number" && config.monthlyLimit.val > 0) {
		const used = typeof config.used?.val === "number" ? config.used.val : 0;
		const resetsAt = grokResetsAt(config.billingPeriodEnd);
		windows.push({
			kind: "other",
			usedPercent: used / config.monthlyLimit.val * 100,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	}
	const plan = typeof payload.subscriptionTier === "string" && payload.subscriptionTier.length > 0 ? payload.subscriptionTier : grokTierName(session.accessToken);
	return {
		supported: true,
		windows,
		...plan === void 0 ? {} : { plan }
	};
}
const GROK_MODELS_URL = "https://api.x.ai/v1/models";
/**
* Input modalities for one grok model: chat models (grok-4 family) accept
* images; code and embedding models are text-only.
*/
function grokModalities(id) {
	return /code|embed/i.test(id) ? ["text"] : ["text", "image"];
}
/**
* The Grok Build CLI chat proxy's model catalog — the only grok endpoint that
* advertises reasoning capability. The `api.x.ai/v1/models` and
* `/v1/language-models` payloads carry pricing, context, and aliases only, so
* effort metadata must come from here (the same source the official CLI's
* picker uses).
*/
const GROK_CLI_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
/** Map one CLI catalog entry's reasoning fields, or undefined when unsupported. */
function grokCliReasoning(entry) {
	if (entry.supports_reasoning_effort !== true) return void 0;
	const efforts = (entry.reasoning_efforts ?? []).filter((level) => typeof level.value === "string" && level.value.length > 0).map((level) => ({
		id: ReasoningEffortId(level.value),
		name: typeof level.label === "string" && level.label.length > 0 ? level.label : level.value,
		...typeof level.description === "string" && level.description.length > 0 ? { description: level.description } : {}
	}));
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof entry.reasoning_effort === "string" && efforts.some((effort) => effort.id === ReasoningEffortId(entry.reasoning_effort)) ? ReasoningEffortId(entry.reasoning_effort) : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
/**
* Fetch the CLI catalog and index its per-model metadata by model id.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation (pool-assembly timeout).
* @returns model id → contributed metadata.
*/
async function fetchGrokCliCatalog(session, fetchFn = proxiedFetch, signal) {
	const response = await fetchFn(GROK_CLI_MODELS_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"x-xai-token-auth": "xai-grok-cli",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok CLI catalog");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("grok CLI catalog returned no data array");
	const catalog = /* @__PURE__ */ new Map();
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0) continue;
		const reasoning = grokCliReasoning(entry);
		catalog.set(entry.id, {
			...typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {},
			...typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {},
			...typeof entry.context_window === "number" && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	return catalog;
}
/**
* The /v1/models list also serves generation models that cannot chat
* (grok-imagine-image*, grok-imagine-video*) and embedding models; the picker
* must not offer them. Heuristic over the id substring, verified against the
* live catalog (grok-build-0.1 and the grok-4 family pass).
*/
function isChatModel(id) {
	return !/imagine|image-|video|embed/i.test(id);
}
/**
* CLI-contributed fields carried forward from a previously discovered model.
* @param prior - the last-known entry for this id, if any.
* @returns enrichment to apply when the live CLI catalog cannot contribute.
*/
function grokPriorMeta(prior) {
	if (prior === void 0) return {};
	return {
		...prior.name.length > 0 ? { name: prior.name } : {},
		...prior.description === void 0 ? {} : { description: prior.description },
		...prior.contextWindow === void 0 ? {} : { contextWindow: prior.contextWindow },
		...prior.reasoning === void 0 ? {} : { reasoning: prior.reasoning }
	};
}
/**
* Fetch the live grok model list, enriched with the CLI catalog's per-model
* metadata (display name, context window, reasoning efforts). The api.x.ai
* list stays authoritative for which models exist; the CLI catalog is
* enrichment only, so its failure degrades to a plain list instead of taking
* discovery down. When enrichment is missing, last-known capability metadata
* is carried forward so a transient CLI outage cannot strip efforts a
* session already selected.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param onWarn - warning sink for a failed CLI catalog fetch.
* @param previous - last-known catalog used to keep enrichment when the CLI
*   catalog is down or omits a model.
* @param signal - caller cancellation (pool-assembly timeout).
* @returns discovered chat models in endpoint order.
*/
async function fetchGrokModels(session, fetchFn = proxiedFetch, onWarn, previous, signal) {
	const previousById = previous === void 0 || previous.length === 0 ? void 0 : new Map(previous.map((model) => [model.id, model]));
	const [response, cliCatalog] = await Promise.all([fetchFn(GROK_MODELS_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	}), fetchGrokCliCatalog(session, fetchFn, signal).catch((error) => {
		if (isDiscoveryAborted(error, signal)) throw error;
		onWarn?.(previousById === void 0 ? `grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})` : `grok CLI catalog fetch failed; keeping last-known reasoning efforts (${errorChain(error)})`);
	})]);
	if (!response.ok) throw await oauthEndpointError(response, "grok models");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("grok models endpoint returned no data array");
	const seen = /* @__PURE__ */ new Set();
	const discovered = [];
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0 || seen.has(entry.id)) continue;
		if (!isChatModel(entry.id)) continue;
		seen.add(entry.id);
		const cli = cliCatalog?.get(entry.id);
		discovered.push({
			id: entry.id,
			name: entry.id,
			...cli ?? grokPriorMeta(previousById?.get(entry.id))
		});
	}
	if (discovered.length === 0) throw new Error("grok models endpoint returned an empty catalog");
	return discovered;
}
/**
* Build one xAI Responses request body (exported for tests, like
* {@link codexRequestBody}). The tool trio renders only when tools exist:
* A reported xAI 400 invalid-argument on tool-less calls motivated omitting
* tool controls when no tools are supplied. Keep this endpoint-specific
* compatibility measure separate from assumptions about other backends.
*/
function grokRequestBody(options, resolved) {
	return {
		model: options.model,
		...resolved.instructions === void 0 ? {} : { instructions: resolved.instructions },
		input: resolved.input,
		...options.tools !== void 0 && options.tools.length > 0 ? {
			tools: toResponsesTools(options.tools),
			tool_choice: "auto",
			parallel_tool_calls: true
		} : {},
		...options.maxTokens !== void 0 ? { max_output_tokens: options.maxTokens } : {},
		...options.reasoningEffort !== void 0 ? { reasoning: { effort: String(options.reasoningEffort) } } : {},
		...options.sessionId !== void 0 ? { prompt_cache_key: String(options.sessionId) } : {},
		store: false,
		stream: true
	};
}
/** Grok wire adapter: one instance serves the `grok` provider route. */
var GrokAdapter = class extends LlmAdapter {
	catalog;
	/** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
	accountCatalogs = /* @__PURE__ */ new Map();
	/** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
	catalogOwner;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	/** Discovery fetcher: resolves the session through the refresh-aware path. */
	async fetchCatalog(account, signal) {
		const lastKnown = account === void 0 || account === await this.options.tokens.defaultAccount() ? this.catalog.lastKnown() : this.accountCatalogs.get(account)?.lastKnown();
		return fetchGrokModels(await this.options.tokens.session(account), this.options.fetchFn, this.options.onWarn, lastKnown, signal);
	}
	/** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
	clearAccountCatalog(account) {
		if (account === void 0) this.accountCatalogs.clear();
		else this.accountCatalogs.delete(account);
		if (account === void 0 || this.catalogOwner === account || this.catalogOwner === void 0) {
			this.catalogOwner = void 0;
			this.catalog.invalidate();
		}
	}
	/** Persisted cache for the default account; a throwaway cache for any other. */
	async catalogFor(account) {
		const defaultKey = await this.options.tokens.defaultAccount();
		const key = account ?? defaultKey;
		if (key === void 0 || key === defaultKey) {
			if (this.catalogOwner !== void 0 && this.catalogOwner !== defaultKey) this.catalog.invalidate();
			this.catalogOwner = defaultKey;
			return this.catalog;
		}
		let cache = this.accountCatalogs.get(key);
		if (cache === void 0) {
			cache = new ModelCatalogCache();
			this.accountCatalogs.set(key, cache);
		}
		return cache;
	}
	listed(provider, discovered) {
		return discovered.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: grokModalities(model.id)
		}));
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Grok (Subscription)"
		};
	}
	providerRetryPolicy(provider) {
		return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `grok: provider "${provider}" retryPolicy`);
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? grokModalities(model.id)
		}));
	}
	async listModels(provider) {
		const own = await this.listOwnModels(provider);
		const pool = this.options.pool?.();
		if (pool === void 0) return own;
		const extra = await pool.modelsForProvider(provider);
		const seen = new Set(own.map((model) => model.id));
		return [...own, ...extra.filter((model) => !seen.has(model.id))];
	}
	/** The provider's own catalog: union of every account, or one account when named. */
	async listOwnModels(provider, account, signal) {
		if (account === void 0) {
			const accounts = (await this.options.tokens.list()).map((entry) => entry.key);
			if (accounts.length === 0) return [];
			return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal), {
				timeoutMs: DISCOVERY_TIMEOUT_MS,
				...signal === void 0 ? {} : { signal }
			});
		}
		if (!await this.options.tokens.hasSession(account)) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		const catalog = await this.catalogFor(account);
		try {
			return this.listed(provider, await discoverOrRetryAuth((force) => this.options.tokens.session(account, force), catalog, () => catalog.get(() => this.fetchCatalog(account, signal))));
		} catch (error) {
			if (isDiscoveryAborted(error, signal)) throw error;
			if (isMissingOrInvalidCredential(error)) return [];
			this.options.onWarn?.(`grok model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	/**
	* The discovered entry for one model. Resolved through the cache's
	* stale-while-revalidate path: capability metadata must stay stable across
	* a long conversation — a session that selected a reasoning effort calls
	* this on EVERY step, and forgetting the efforts just because the TTL
	* lapsed mid-turn would fail the call with UNSUPPORTED_REASONING_EFFORT
	* before provider I/O.
	*/
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return discoverAcrossAccounts((await this.options.tokens.list()).map((entry) => entry.key), async (account) => {
			return (await (await this.catalogFor(account)).resolve(() => this.fetchCatalog(account)))?.find((entry) => entry.id === model);
		});
	}
	async resolveModel(provider, model) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(provider, model)) return pool.resolveModel(provider, model);
		return this.resolveOwnModel(provider, model);
	}
	/** Capability resolution of the provider's own models (the pool resolves members here). */
	async resolveOwnModel(provider, model) {
		const discovered = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning);
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: configured?.inputModalities ?? grokModalities(model),
			context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async *stream(options) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(options.provider, options.model)) {
			yield* pool.stream(options);
			return;
		}
		yield* this.streamCore(options);
	}
	/** Pool seam: stream through one specific account instead of the default. */
	streamAccount(options, account) {
		return this.streamCore(options, account);
	}
	async *streamCore(options, account) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session(account);
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) {
				session = await this.options.tokens.session(account, true);
				response = await this.request(options, session, watchdog.signal);
			}
			if (!response.ok) throw await httpLlmError(response, "grok API", {
				rateLimitReset: grokRateLimitReset,
				...this.options.onWarn === void 0 ? {} : { onWarn: this.options.onWarn }
			});
			if (response.body === null) throw new LlmError("grok API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamResponses(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("grok API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	async request(options, session, signal) {
		const body = grokRequestBody(options, toResponsesInput(await resolveImages(dsh1cCodexMessages(options.messages), this.options.resolveAttachments?.(), signal), options.system));
		return proxiedFetch(GROK_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"accept": "text/event-stream",
				"content-type": "application/json",
				...attributionHeaders()
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion
//#region src/translate/chat-completions.ts
/** Flatten a tool result's content to plain text for a `tool` message. */
function toolResultText(block) {
	return block.content.map((part) => part.type === "text" ? part.text : "").join("");
}
/**
* Convert harness messages into chat completions `messages`. System-role
* messages become one leading `system` message; an explicit `system` argument
* wins over them when both exist. Reasoning blocks are not replayed (matching
* the Responses translator). Images must arrive pre-resolved; an unresolved
* ImageBlock is skipped because its bytes are unreachable here. A user message
* carrying only text collapses to a plain string body (some endpoints still
* reject content-part arrays); tool results become separate `tool` messages.
* @param messages - ordered conversation messages with resolved images.
* @param system - explicit system prompt, which takes precedence.
* @returns the wire `messages` array.
*/
function toChatMessages(messages, system) {
	const out = [];
	const systemTexts = [];
	for (const message of withToolResultImages(messages)) {
		if (message.role === "system") {
			for (const block of message.content) if (block.type === "text") systemTexts.push(block.text);
			continue;
		}
		if (message.role === "user") {
			let texts$1 = [];
			let parts = [];
			const flushUser = () => {
				if (parts.length > 0) {
					if (texts$1.length > 0) parts.unshift({
						type: "text",
						text: texts$1.join("\n")
					});
					out.push({
						role: "user",
						content: parts
					});
				} else if (texts$1.length > 0) out.push({
					role: "user",
					content: texts$1.join("\n")
				});
				texts$1 = [];
				parts = [];
			};
			for (const block of message.content) switch (block.type) {
				case "text":
					if (parts.length > 0) parts.push({
						type: "text",
						text: block.text
					});
					else texts$1.push(block.text);
					break;
				case "image":
					if ("dataBase64" in block) parts.push({
						type: "image_url",
						image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` }
					});
					break;
				case "tool-result":
					flushUser();
					out.push({
						role: "tool",
						tool_call_id: String(block.toolCallId),
						content: toolResultText(block)
					});
					break;
				default: break;
			}
			flushUser();
			continue;
		}
		const texts = [];
		const toolCalls = [];
		for (const block of message.content) switch (block.type) {
			case "text":
				texts.push(block.text);
				break;
			case "tool-call":
				toolCalls.push({
					id: String(block.id),
					type: "function",
					function: {
						name: block.name,
						arguments: block.arguments
					}
				});
				break;
			default: break;
		}
		if (texts.length === 0 && toolCalls.length === 0) continue;
		out.push({
			role: "assistant",
			content: texts.join("\n"),
			...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
		});
	}
	const systemText = system ?? (systemTexts.length > 0 ? systemTexts.join("\n\n") : void 0);
	if (systemText !== void 0) out.unshift({
		role: "system",
		content: systemText
	});
	return out;
}
/**
* Map harness tool schemas to chat completions function tools.
* @param tools - tool schemas from the request.
* @returns the wire `tools` array.
*/
function toChatTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
}
/**
* Map chat completions usage to disjoint harness counts (cached input is
* subtracted out of `inputTokens` and reported as `cacheReadTokens`).
* @param usage - wire usage from the terminal chunk.
* @returns harness token usage.
*/
function mapChatCompletionsUsage(usage) {
	const cached = usage.prompt_tokens_details?.cached_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cached ?? 0),
		outputTokens: usage.completion_tokens,
		...cached !== void 0 ? { cacheReadTokens: cached } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Push-model chat completions SSE translator: feed each parsed chunk object
* to {@link push} and collect the emitted harness StreamChunks. The terminal
* `finish_reason` chunk closes every block but only ARMS the finish chunk —
* usage must precede the terminal finish, and where usage lives differs by
* upstream: OpenAI-style streams send a trailing usage-only chunk
* (stream_options.include_usage), while Copilot's Gemini models attach a
* (zero) usage object to EVERY chunk and fold the real usage into the
* finish chunk itself. A chunk therefore never early-returns on `usage`
* alone: its deltas are always processed, and the terminal pair is drained
* when the finish is armed and usage arrived (or when a usage-only chunk
* follows an armed finish). `flush()` emits whatever remains when the
* stream's `[DONE]` (or EOF) arrives.
*/
var ChatCompletionsStreamTranslator = class {
	/** Text/reasoning blocks keyed by kind; tool calls keyed by their wire index. */
	blocks = /* @__PURE__ */ new Map();
	order = [];
	nextIndex = 0;
	sawToolCall = false;
	pendingUsage;
	armedFinish;
	/** Set once the terminal finish chunk was emitted. */
	terminated = false;
	open(key, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(key, block);
		this.order.push(block);
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	close(key, chunks) {
		const block = this.blocks.get(key);
		if (block === void 0) return;
		this.blocks.delete(key);
		chunks.push({
			type: "block-end",
			index: block.index,
			block: closeBlock(block)
		});
	}
	closeAll(chunks) {
		for (const key of [...this.blocks.keys()]) this.close(key, chunks);
	}
	/** Build the terminal finish chunk for one wire finish reason. */
	finishChunk(finishReason) {
		if (this.order.length === 0) return {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: "model returned a completed response with no content",
					code: EMPTY_RESPONSE_CODE
				}
			}
		};
		switch (finishReason) {
			case "tool_calls": return {
				type: "finish",
				reason: { kind: "tool-calls" }
			};
			case "length": return {
				type: "finish",
				reason: { kind: "max-tokens" }
			};
			case "content_filter": return {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: "the response was blocked by the provider content filter",
						code: "CONTENT_FILTER"
					}
				}
			};
			default: return {
				type: "finish",
				reason: { kind: this.sawToolCall ? "tool-calls" : "stop" }
			};
		}
	}
	/** Usage, then the armed finish: the only order the harness accepts. */
	drainTerminal(chunks) {
		if (this.pendingUsage !== void 0) {
			chunks.push({
				type: "usage",
				usage: mapChatCompletionsUsage(this.pendingUsage)
			});
			this.pendingUsage = void 0;
		}
		if (this.armedFinish !== void 0) {
			chunks.push(this.armedFinish);
			this.armedFinish = void 0;
			this.terminated = true;
		}
	}
	/**
	* Process one parsed chat-completion chunk.
	* @param event - the parsed chunk object.
	* @returns the StreamChunks this event produced (possibly none).
	*/
	push(event) {
		if (this.terminated) return [];
		const chunks = [];
		const usage = event.usage;
		const hasUsage = usage !== void 0 && usage !== null;
		if (hasUsage) this.pendingUsage = usage;
		const choice = event.choices?.[0];
		const delta = choice?.delta;
		if (delta !== void 0) {
			if (typeof delta.content === "string" && delta.content.length > 0) {
				const block = this.blocks.get("content") ?? this.open("content", "text", chunks);
				block.text += delta.content;
				chunks.push({
					type: "text-delta",
					index: block.index,
					text: delta.content
				});
			}
			const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning_text === "string" ? delta.reasoning_text : void 0;
			if (reasoning !== void 0 && reasoning.length > 0) {
				const block = this.blocks.get("reasoning") ?? this.open("reasoning", "reasoning", chunks);
				block.text += reasoning;
				chunks.push({
					type: "reasoning-delta",
					index: block.index,
					text: reasoning
				});
			}
			for (const call of delta.tool_calls ?? []) {
				const key = `call:${String(call.index ?? 0)}`;
				let block = this.blocks.get(key);
				if (block === void 0) {
					this.sawToolCall = true;
					block = this.open(key, "tool-call", chunks, call.id ?? "", call.function?.name);
					chunks.push({
						type: "tool-call-delta",
						index: block.index,
						id: ToolCallId(block.callId),
						...block.name === void 0 ? {} : { name: block.name },
						argumentsDelta: ""
					});
				}
				if (call.function?.arguments !== void 0 && call.function.arguments.length > 0) {
					block.text += call.function.arguments;
					chunks.push({
						type: "tool-call-delta",
						index: block.index,
						id: ToolCallId(block.callId),
						argumentsDelta: call.function.arguments
					});
				}
			}
		}
		if (choice?.finish_reason !== void 0 && choice.finish_reason !== null) {
			this.closeAll(chunks);
			if (this.armedFinish === void 0) this.armedFinish = this.finishChunk(choice.finish_reason);
		}
		if (hasUsage && (this.armedFinish !== void 0 || choice === void 0)) this.drainTerminal(chunks);
		return chunks;
	}
	/**
	* Emit whatever the stream left pending (`[DONE]` or EOF without a final
	* usage chunk). Safe to call repeatedly.
	* @returns the remaining terminal chunks.
	*/
	flush() {
		const chunks = [];
		this.drainTerminal(chunks);
		return chunks;
	}
};
/**
* Consume a chat completions SSE byte stream and yield harness StreamChunks.
* @param stream - raw response body.
* @param onActivity - transport-activity callback for the idle watchdog.
* @returns the chunk stream; throws when the stream ends before any finish chunk.
*/
async function* streamChatCompletions(stream, onActivity) {
	const translator = new ChatCompletionsStreamTranslator();
	for await (const sseEvent of parseSse(stream, onActivity)) {
		if (sseEvent.data === "[DONE]") {
			yield* translator.flush();
			return;
		}
		let event;
		try {
			event = JSON.parse(sseEvent.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		yield* translator.push(event);
		if (translator.terminated) return;
	}
	yield* translator.flush();
	if (!translator.terminated) throw new LlmError("chat completions SSE stream ended before a finish chunk", "STREAM_CLOSED");
}

//#endregion
//#region src/providers/copilot.ts
/**
* Client id of the VS Code Copilot Chat GitHub App (pi-mono and
* copilot2api-go use the same value): the app is pre-authorized for the
* Copilot internal token exchange, a self-registered OAuth App is not.
*/
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
const COPILOT_DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_USER_URL = "https://api.github.com/user";
const COPILOT_API_URL = "https://api.githubcopilot.com/chat/completions";
/** Responses endpoint for models whose catalog entry only lists `/responses`. */
const COPILOT_RESPONSES_URL = "https://api.githubcopilot.com/responses";
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
const COPILOT_SCOPE = "read:user";
const COPILOT_CONTEXT_WINDOW = 128e3;
const COPILOT_DEFAULT_MAX_TOKENS = 16e3;
/** Refresh when the Copilot API token has less than this much life left. */
const COPILOT_PREEMPT_MS = 5 * 6e4;
/**
* The VS Code update feed answers a JSON array of version strings, latest
* stable first. The Copilot API rejects requests whose Editor-Version is too
* old with `401 IDE token expired`, so the version is resolved live (cached
* for a day) instead of hardcoded — a stale hardcode bricks every request.
*/
const VSCODE_RELEASES_URL = "https://update.code.visualstudio.com/api/releases/stable";
/** Last-known-good VS Code version when the feed is unreachable. */
const FALLBACK_VSCODE_VERSION = "1.107.0";
const VSCODE_VERSION_TTL_MS = 24 * 36e5;
let vscodeVersionCache;
let vscodeVersionInflight;
/**
* Resolve the VS Code version presented as Editor-Version: the latest stable
* from the update feed, cached for a day, falling back to a pinned version
* when the feed fails. Concurrent resolves coalesce behind one fetch.
* @param fetchFn - fetch implementation (injectable for tests).
* @param forceRefresh - bypass the cache (a 401 `IDE token expired` retry).
* @returns a `major.minor.patch` version string.
*/
async function latestVsCodeVersion(fetchFn = proxiedFetch, forceRefresh = false) {
	if (!forceRefresh && vscodeVersionCache !== void 0 && Date.now() - vscodeVersionCache.at < VSCODE_VERSION_TTL_MS) return vscodeVersionCache.version;
	vscodeVersionInflight ??= (async () => {
		try {
			const response = await fetchFn(VSCODE_RELEASES_URL, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			const releases = await response.json();
			const version = Array.isArray(releases) ? releases.find((entry) => typeof entry === "string" && /^\d+\.\d+\.\d+$/.test(entry)) : void 0;
			if (version === void 0) throw new Error("no version string in the feed");
			vscodeVersionCache = {
				version,
				at: Date.now()
			};
			return version;
		} catch {
			return vscodeVersionCache?.version ?? FALLBACK_VSCODE_VERSION;
		}
	})().finally(() => {
		vscodeVersionInflight = void 0;
	});
	return vscodeVersionInflight;
}
/**
* The device-flow facts for the auth controller's DeviceFlowManager.
* @returns the flow spec for one attempt.
*/
function copilotDeviceFlow() {
	return {
		clientId: COPILOT_CLIENT_ID,
		scope: COPILOT_SCOPE,
		deviceCodeUrl: COPILOT_DEVICE_CODE_URL,
		tokenUrl: COPILOT_DEVICE_TOKEN_URL
	};
}
/**
* Header set presenting requests as the VS Code Copilot Chat extension; the
* Copilot API rejects traffic without an editor identity.
* @param hasVision - whether the request carries image input.
* @param vscodeVersion - Editor-Version value from {@link latestVsCodeVersion}.
* @returns headers to merge into Copilot API requests.
*/
function copilotHeaders(hasVision = false, vscodeVersion = FALLBACK_VSCODE_VERSION) {
	return {
		"user-agent": "GitHubCopilotChat/0.35.0",
		"editor-version": `vscode/${vscodeVersion}`,
		"editor-plugin-version": "copilot-chat/0.35.0",
		"copilot-integration-id": "vscode-chat",
		"openai-intent": "conversation-edits",
		"x-github-api-version": "2026-06-01",
		...hasVision ? { "copilot-vision-request": "true" } : {}
	};
}
/**
* Exchange a long-lived GitHub OAuth token for a short-lived Copilot API
* token. A 401/403 means the GitHub token is revoked or the account lost its
* Copilot subscription — permanent, re-login required.
* @param githubToken - the GitHub OAuth token from the device flow.
* @param fetchFn - fetch implementation (injectable for tests).
* @returns the Copilot API token and its expiry.
*/
async function exchangeCopilotToken(githubToken, fetchFn = proxiedFetch) {
	const response = await fetchFn(COPILOT_TOKEN_URL, { headers: {
		"authorization": `Bearer ${githubToken}`,
		"accept": "application/json",
		...copilotHeaders(false, await latestVsCodeVersion(fetchFn))
	} });
	if (!response.ok) throw await oauthEndpointError(response, "copilot");
	const wire = await response.json();
	if (typeof wire.token !== "string" || wire.token.length === 0) throw new Error("copilot token endpoint returned no token");
	return {
		accessToken: wire.token,
		expiresAt: typeof wire.expires_at === "number" && wire.expires_at > 0 ? wire.expires_at * 1e3 : Date.now() + 25 * 6e4
	};
}
/**
* Complete a device-flow login: exchange the GitHub token for a Copilot API
* token and read the GitHub login name for the status display.
* @param githubToken - the GitHub OAuth token the device flow released.
* @param fetchFn - fetch implementation (injectable for tests).
* @returns the session to store.
*/
async function completeCopilotLogin(githubToken, fetchFn = proxiedFetch) {
	const pair = await exchangeCopilotToken(githubToken, fetchFn);
	let account;
	try {
		const response = await fetchFn(GITHUB_USER_URL, { headers: {
			"authorization": `Bearer ${githubToken}`,
			"accept": "application/json",
			"user-agent": "GitHubCopilotChat/0.35.0"
		} });
		if (response.ok) {
			const profile = await response.json();
			if (typeof profile.login === "string" && profile.login.length > 0) account = profile.login;
		}
	} catch {}
	return {
		accessToken: pair.accessToken,
		refreshToken: githubToken,
		expiresAt: pair.expiresAt,
		...account === void 0 ? {} : { account }
	};
}
/**
* Refresh a copilot session: re-exchange the long-lived GitHub token for a
* fresh Copilot API token.
* @param session - the stored session.
* @param fetchFn - fetch implementation (injectable for tests).
* @returns the fresh session to store.
*/
async function refreshCopilot(session, fetchFn = proxiedFetch) {
	const pair = await exchangeCopilotToken(session.refreshToken, fetchFn);
	return {
		accessToken: pair.accessToken,
		refreshToken: session.refreshToken,
		expiresAt: pair.expiresAt,
		...session.account === void 0 ? {} : { account: session.account }
	};
}
/**
* Whether a copilot refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix (GitHub token revoked or the subscription lost).
*/
function isCopilotPermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && (error.status === 401 || error.status === 403);
}
/** Display name for one Copilot wire reasoning-effort value. */
function copilotEffortName(effort) {
	return effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);
}
/**
* Map a catalog entry's `supports.reasoning_effort` array into selectable
* efforts. The endpoint discloses no default effort, so none is claimed
* (absence preserves the provider's own default). Duplicates and non-string
* entries are dropped: the harness rejects duplicate effort ids outright.
*/
function copilotReasoning(entry) {
	const wire = entry.capabilities?.supports?.reasoning_effort;
	if (!Array.isArray(wire)) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const efforts = [];
	for (const value of wire) {
		if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
		seen.add(value);
		efforts.push({
			id: ReasoningEffortId(value),
			name: copilotEffortName(value)
		});
	}
	return efforts.length > 0 ? { efforts } : void 0;
}
/**
* Fetch the live Copilot model list. Models hidden from the picker or
* disabled by policy are excluded, as are models able to speak neither
* protocol this adapter knows: an entry listing `/chat/completions` speaks
* the chat wire, one listing only `/responses` (the newer GPT families,
* e.g. gpt-5.6) speaks the Responses wire, and the choice is recorded on the
* discovered entry so requests pick the matching endpoint; an entry listing
* BOTH endpoints additionally records `/responses` availability, which
* {@link copilotRequestWire} uses to reroute tools+effort requests. Vision
* support from the catalog becomes the model's input modalities, and a
* non-empty `supports.reasoning_effort` array becomes the model's selectable
* reasoning efforts (the endpoint discloses no default, so none is claimed).
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation (pool-assembly timeout).
* @returns discovered chat models in endpoint order.
*/
async function fetchCopilotModels(session, fetchFn = proxiedFetch, signal) {
	const response = await fetchFn(COPILOT_MODELS_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"accept": "application/json",
			...copilotHeaders(false, await latestVsCodeVersion(fetchFn))
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "copilot models");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("copilot models endpoint returned no data array");
	const seen = /* @__PURE__ */ new Set();
	const discovered = [];
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0 || seen.has(entry.id)) continue;
		if (entry.model_picker_enabled !== true || entry.policy?.state === "disabled") continue;
		let wire;
		let responsesSupported = false;
		if (Array.isArray(entry.supported_endpoints)) {
			responsesSupported = entry.supported_endpoints.includes("/responses");
			if (entry.supported_endpoints.includes("/chat/completions")) wire = "chat-completions";
			else if (responsesSupported) wire = "responses";
			else continue;
		}
		seen.add(entry.id);
		const reasoning = copilotReasoning(entry);
		discovered.push({
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			...typeof entry.capabilities?.limits?.max_context_window_tokens === "number" && entry.capabilities.limits.max_context_window_tokens > 0 ? { contextWindow: entry.capabilities.limits.max_context_window_tokens } : {},
			inputModalities: entry.capabilities?.supports?.vision === true ? ["text", "image"] : ["text"],
			...reasoning === void 0 ? {} : { reasoning },
			...wire === void 0 ? {} : { copilotWire: wire },
			...responsesSupported ? { copilotResponses: true } : {}
		});
	}
	if (discovered.length === 0) throw new Error("copilot models endpoint returned an empty catalog");
	return discovered;
}
/**
* The wire protocol for one model: the discovered catalog entry's recorded
* choice, defaulting to chat completions for unknown models (static-catalog
* and no-discovery configurations, and models listing both endpoints).
* @param entry - the discovered catalog entry, when known.
* @returns the protocol the request for this model must speak.
*/
function copilotWireFor(entry) {
	return entry?.copilotWire === "responses" ? "responses" : "chat-completions";
}
/**
* The upstream protocol for ONE REQUEST: the model's default wire, except
* that a dual-protocol model defaulting to chat completions must reroute to
* Responses when the request combines function tools with a reasoning effort
* — Copilot rejects exactly that combination on /chat/completions with
* HTTP 400 invalid_request_body ("Function tools with reasoning_effort are
* not supported … use /v1/responses or set reasoning_effort to 'none'",
* observed on gpt-5.4) while /responses serves it. Effort 'none' stays on
* the chat wire (the API allows the combination there), and models not
* listing /responses never reroute.
* @param entry - the discovered catalog entry, when known.
* @param options - the harness generate options (tools + effort only).
* @returns the protocol the request for this model must speak.
*/
function copilotRequestWire(entry, options) {
	const wire = copilotWireFor(entry);
	if (wire !== "chat-completions") return wire;
	if (entry?.copilotResponses !== true) return wire;
	if (options.tools === void 0 || options.tools.length === 0) return wire;
	if (options.reasoningEffort === void 0 || options.reasoningEffort === "none") return wire;
	return "responses";
}
/**
* The chat completions request body for one generation. The output cap rides
* `max_completion_tokens` — the newer OpenAI-family models on Copilot reject
* the legacy `max_tokens` parameter outright (HTTP 400 "Unsupported
* parameter"), and the rest of the catalog accepts the new spelling.
* @param options - the harness generate options.
* @param messages - translated wire messages (images pre-resolved).
* @returns the JSON body.
*/
function copilotChatRequestBody(options, messages) {
	return {
		model: options.model,
		messages,
		...options.tools !== void 0 && options.tools.length > 0 ? {
			tools: toChatTools(options.tools),
			tool_choice: "auto"
		} : {},
		...options.maxTokens !== void 0 ? { max_completion_tokens: options.maxTokens } : {},
		...options.reasoningEffort !== void 0 ? { reasoning_effort: String(options.reasoningEffort) } : {},
		stream: true,
		stream_options: { include_usage: true }
	};
}
/**
* The Responses request body for one generation (the wire the `/responses`-
* only model families speak). Usage arrives on `response.completed`.
* @param options - the harness generate options.
* @param resolved - translated instructions + input (images pre-resolved).
* @returns the JSON body.
*/
function copilotResponsesRequestBody(options, resolved) {
	return {
		model: options.model,
		...resolved.instructions !== void 0 ? { instructions: resolved.instructions } : {},
		input: resolved.input,
		...options.tools !== void 0 && options.tools.length > 0 ? {
			tools: toResponsesTools(options.tools, { strict: false }),
			tool_choice: "auto"
		} : {},
		...options.maxTokens !== void 0 ? { max_output_tokens: options.maxTokens } : {},
		...options.reasoningEffort !== void 0 ? { reasoning: { effort: String(options.reasoningEffort) } } : {},
		include: ["reasoning.encrypted_content"],
		stream: true
	};
}
/**
* The replayable form of one completed reasoning item: the COMPLETE item as
* the gateway delivered it on `response.output_item.done` — its ORIGINAL id
* (captured before the stable-key rewrite), summary parts, status, and the
* encrypted payload. A reasoning item's `id` and `summary` are not optional
* in the Responses input schema, so an item missing its id or its blob is
* not replayable and degrades to the no-replay path instead of risking an
* invalid input item.
*/
function completedReasoningItem(item) {
	if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) return void 0;
	if (typeof item.id !== "string" || item.id.length === 0) return void 0;
	return {
		type: "reasoning",
		id: item.id,
		...Array.isArray(item.summary) ? { summary: item.summary } : {},
		...typeof item.status === "string" && item.status.length > 0 ? { status: item.status } : {},
		encrypted_content: item.encrypted_content
	};
}
/**
* Rewrite Copilot's Responses-gateway item ids into stable per-item keys.
* Unlike chatgpt.com's Responses backend, the Copilot gateway mints a FRESH
* opaque `item.id`/`item_id` on every event of one response (the `added`,
* each delta, and the `done` all differ), which defeats id-keyed block
* assembly in the shared translator: text fragments would each open their
* own block, `done` would synthesize duplicates, and a function call whose
* arguments arrive whole only on `done` (the deltas carry empty strings)
* would close empty. The stable key derives from the event's `output_index`
* — the item's position in the response's output array, which survives the
* gateway's per-event id churn even when two items' events interleave on
* the wire (parallel tool calls do exactly that). Events without an
* `output_index` fall back to the key of the last `output_item.added`, which
* is only correct while one item's events stay contiguous — the pre-
* interleaving behavior, kept for gateways that omit the field; with no
* `added` seen yet they key to `copilot-item-0` as before. Function-call
* identity additionally rides the gateway-stable `call_id`.
*/
var CopilotResponsesItemNormalizer = class {
	adds = 0;
	lastKey = "copilot-item-0";
	/** Call ids and completed reasoning items collected for the open response. */
	capturedCallIds = [];
	capturedReasoning = [];
	/**
	* @param onCaptured - fired at each `response.completed` that produced BOTH
	*   function calls and completed reasoning items, receiving the response's
	*   call ids and replayable reasoning items so the adapter can replay them
	*   on the next request.
	*/
	constructor(onCaptured) {
		this.onCaptured = onCaptured;
	}
	/**
	* [2026-08-23]-[a single arrival-order ordinal mis-buckets every event after
	* a second item's `added`, mangling interleaved parallel tool calls;
	* output_index is the only correlator the gateway keeps stable]-[changes
	* keys only for streams that carry output_index; no-index streams keep the
	* old last-added-key behavior byte for byte]
	*/
	keyFor(event) {
		return event.output_index !== void 0 ? `copilot-item-${String(event.output_index)}` : this.lastKey;
	}
	/**
	* Rewrite one parsed Responses event.
	* @param event - the event as parsed off the wire.
	* @returns the event with a stable item key.
	*/
	push(event) {
		if (event.type === "response.output_item.added") {
			this.adds += 1;
			const key = event.output_index !== void 0 ? `copilot-item-${String(event.output_index)}` : `copilot-item-${String(this.adds)}`;
			this.lastKey = key;
			const item = event.item;
			if (item?.type === "function_call" && typeof item.call_id === "string" && item.call_id.length > 0) this.capturedCallIds.push(item.call_id);
			return item === void 0 ? event : {
				...event,
				item: {
					...item,
					id: key
				}
			};
		}
		if (event.type === "response.output_item.done") {
			const item = event.item;
			if (item?.type === "reasoning") {
				const captured = completedReasoningItem(item);
				if (captured !== void 0) this.capturedReasoning.push(captured);
			}
			return item === void 0 ? event : {
				...event,
				item: {
					...item,
					id: this.keyFor(event)
				}
			};
		}
		if (event.type === "response.completed") {
			if (this.capturedCallIds.length > 0 && this.capturedReasoning.length > 0) this.onCaptured?.(this.capturedCallIds, this.capturedReasoning);
			this.capturedCallIds = [];
			this.capturedReasoning = [];
			return event;
		}
		if (event.item_id === void 0) return event;
		return {
			...event,
			item_id: this.keyFor(event)
		};
	}
};
/** Copilot wire adapter: one instance serves the `copilot` provider route. */
var CopilotAdapter = class CopilotAdapter extends LlmAdapter {
	catalog;
	/** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
	accountCatalogs = /* @__PURE__ */ new Map();
	/** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
	catalogOwner;
	/**
	* [2026-08-23]-[a reasoning model continuing a tool chain must get its
	* reasoning back or it restarts from scratch every tool round trip; the
	* items live in ADAPTER memory because dsh-llm's reasoning ContentBlock is
	* a closed shape that cannot carry them through the harness]-[entries are
	* namespaced per ACCOUNT × CONVERSATION × MODEL, idle out via a sliding
	* TTL, and the whole store is dropped on auth transitions, so replay
	* degrades to the old behavior instead of leaking across contexts]
	*/
	replayByScope = /* @__PURE__ */ new Map();
	/** Call-id entries kept per scope; see {@link captureReasoning}. */
	static REPLAY_CALL_LIMIT = 64;
	/** Conversation scopes kept at once; bounds memory when many sessions interleave. */
	static REPLAY_SCOPE_LIMIT = 32;
	/** How long a captured entry stays replayable; tool round trips take minutes, not hours. */
	static REPLAY_TTL_MS = 30 * 6e4;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	/** Discovery fetcher: resolves the session through the refresh-aware path. */
	async fetchCatalog(account, signal) {
		return fetchCopilotModels(await this.options.tokens.session(account), this.options.fetchFn, signal);
	}
	/** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
	clearAccountCatalog(account) {
		if (account === void 0) this.accountCatalogs.clear();
		else this.accountCatalogs.delete(account);
		if (account === void 0 || this.catalogOwner === account || this.catalogOwner === void 0) {
			this.catalogOwner = void 0;
			this.catalog.invalidate();
		}
	}
	/** Persisted cache for the default account; a throwaway cache for any other. */
	async catalogFor(account) {
		const defaultKey = await this.options.tokens.defaultAccount();
		const key = account ?? defaultKey;
		if (key === void 0 || key === defaultKey) {
			if (this.catalogOwner !== void 0 && this.catalogOwner !== defaultKey) this.catalog.invalidate();
			this.catalogOwner = defaultKey;
			return this.catalog;
		}
		let cache = this.accountCatalogs.get(key);
		if (cache === void 0) {
			cache = new ModelCatalogCache();
			this.accountCatalogs.set(key, cache);
		}
		return cache;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "GitHub Copilot"
		};
	}
	providerRetryPolicy(provider) {
		return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `copilot: provider "${provider}" retryPolicy`);
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? ["text"]
		}));
	}
	async listModels(provider) {
		const own = await this.listOwnModels(provider);
		const pool = this.options.pool?.();
		if (pool === void 0) return own;
		const extra = await pool.modelsForProvider(provider);
		const seen = new Set(own.map((model) => model.id));
		return [...own, ...extra.filter((model) => !seen.has(model.id))];
	}
	/** The provider's own catalog: union of every account, or one account when named. */
	async listOwnModels(provider, account, signal) {
		if (account === void 0) {
			const accounts = (await this.options.tokens.list()).map((entry) => entry.key);
			if (accounts.length === 0) return [];
			return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal), {
				timeoutMs: DISCOVERY_TIMEOUT_MS,
				...signal === void 0 ? {} : { signal }
			});
		}
		if (!await this.options.tokens.hasSession(account)) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		const catalog = await this.catalogFor(account);
		try {
			return (await discoverOrRetryAuth((force) => this.options.tokens.session(account, force), catalog, () => catalog.get(() => this.fetchCatalog(account, signal)))).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				...model.inputModalities === void 0 ? {} : { inputModalities: model.inputModalities }
			}));
		} catch (error) {
			if (isDiscoveryAborted(error, signal)) throw error;
			if (isMissingOrInvalidCredential(error)) return [];
			this.options.onWarn?.(`copilot model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	/**
	* The discovered entry for one model. Resolved through the cache's
	* stale-while-revalidate path: capability metadata must stay stable across
	* a long conversation — a mid-turn refetch must neither block nor fail the
	* call before provider I/O.
	*/
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return discoverAcrossAccounts((await this.options.tokens.list()).map((entry) => entry.key), async (account) => {
			return (await (await this.catalogFor(account)).resolve(() => this.fetchCatalog(account)))?.find((entry) => entry.id === model);
		});
	}
	/**
	* [2026-08-23]-[a manually configured responses-only model combined with
	* `discovery:false` left discovered() undefined, so copilotRequestWire
	* silently defaulted to /chat/completions and the request 404/400'd at the
	* gateway; an explicit config wire must win over catalog inference]-[config
	* `models[].wire` now routes the request even without discovery]
	*/
	configuredWireEntry(model) {
		const configured = this.options.models.find((entry) => entry.id === model);
		return configured?.wire === void 0 ? void 0 : {
			id: configured.id,
			name: configured.name ?? configured.id,
			copilotWire: configured.wire
		};
	}
	/**
	* The replay scope isolating one ACCOUNT × CONVERSATION × MODEL. The
	* account identity is the session's long-lived GitHub token (stable across
	* Copilot-token refreshes, different per GitHub login); the conversation is
	* the loop-stamped `sessionId`, falling back to the first message's id
	* when a hand-built request carries no session stamp; the model separates
	* wire families. A call id captured in one scope is invisible to every
	* other scope, so reused ids cannot leak reasoning across accounts,
	* conversations, or models.
	*/
	replayScope(tokenKey, options) {
		return `${tokenKey}\u0000${options.sessionId !== void 0 ? `session:${String(options.sessionId)}` : options.messages[0] !== void 0 ? `anchor:${String(options.messages[0].id)}` : "conversation:none"}\u0000${options.model}`;
	}
	/**
	* Store one response's completed reasoning items behind every call id it
	* produced, inside one replay scope. Retention: a CONSUMED entry is kept —
	* every later round of the same conversation replays ALL its earlier
	* function_calls — until it idles out of the TTL (see {@link replayFor})
	* or the per-scope entry cap evicts it oldest-first. All calls of one
	* response share ONE entry object: toResponsesInput dedupes replays by
	* array reference, so parallel calls replay the items once instead of once
	* per call.
	*/
	captureReasoning(scope, callIds, items) {
		let entries = this.replayByScope.get(scope);
		if (entries === void 0) {
			entries = /* @__PURE__ */ new Map();
			this.replayByScope.set(scope, entries);
		} else {
			this.replayByScope.delete(scope);
			this.replayByScope.set(scope, entries);
		}
		const now = Date.now();
		for (const [callId, entry$1] of entries) if (now - entry$1.at >= CopilotAdapter.REPLAY_TTL_MS) entries.delete(callId);
		const entry = {
			items: [...items],
			at: now
		};
		for (const callId of callIds) entries.set(callId, entry);
		while (entries.size > CopilotAdapter.REPLAY_CALL_LIMIT) {
			const oldest = entries.keys().next().value;
			if (oldest === void 0) break;
			entries.delete(oldest);
		}
		while (this.replayByScope.size > CopilotAdapter.REPLAY_SCOPE_LIMIT) {
			const oldest = this.replayByScope.keys().next().value;
			if (oldest === void 0) break;
			this.replayByScope.delete(oldest);
		}
	}
	/**
	* The replay items for one call id in one scope, when still fresh. The TTL
	* bounds IDLE time, not total age: a hit refreshes the entry (and its
	* eviction recency), so an ongoing conversation keeps its chain alive
	* while a conversation that stopped asking forgets within the TTL. An
	* absent or aged-out entry answers `undefined` — the no-replay
	* degradation, never an error.
	*/
	replayFor(scope, callId) {
		const entries = this.replayByScope.get(scope);
		const entry = entries?.get(callId);
		if (entries === void 0 || entry === void 0) return void 0;
		const now = Date.now();
		if (now - entry.at >= CopilotAdapter.REPLAY_TTL_MS) return void 0;
		entry.at = now;
		entries.delete(callId);
		entries.set(callId, entry);
		this.replayByScope.delete(scope);
		this.replayByScope.set(scope, entries);
		return entry.items;
	}
	/**
	* Drop every captured replay entry. Lookup correctness never depends on
	* the call — the scope already carries the account identity — but the host
	* wiring invokes this on every copilot auth transition (login, logout,
	* credential death) so a switched account's memory never holds the
	* previous account's encrypted reasoning at all; conversation teardown is
	* bounded by the TTL and the caps.
	*/
	clearReplayState() {
		this.replayByScope.clear();
	}
	async resolveModel(provider, model) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(provider, model)) return pool.resolveModel(provider, model);
		return this.resolveOwnModel(provider, model);
	}
	/** Capability resolution of the provider's own models (the pool resolves members here). */
	async resolveOwnModel(provider, model) {
		const discovered = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning);
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ["text"],
			context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? COPILOT_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? COPILOT_DEFAULT_MAX_TOKENS,
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async *stream(options) {
		const pool = this.options.pool?.();
		if (pool !== void 0 && await pool.owns(options.provider, options.model)) {
			yield* pool.stream(options);
			return;
		}
		yield* this.streamCore(options);
	}
	/** Pool seam: stream through one specific account instead of the default. */
	streamAccount(options, account) {
		return this.streamCore(options, account);
	}
	async *streamCore(options, account) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			const wire = copilotRequestWire(this.configuredWireEntry(options.model) ?? await this.discovered(options.model), options);
			let session = await this.options.tokens.session(account);
			const scope = this.replayScope(session.refreshToken, options);
			let response = await this.request(options, session, watchdog.signal, wire, scope);
			if (response.status === 401) {
				await latestVsCodeVersion(this.options.fetchFn ?? proxiedFetch, true);
				session = await this.options.tokens.session(account, true);
				response = await this.request(options, session, watchdog.signal, wire, scope);
			}
			if (!response.ok) throw await httpLlmError(response, "copilot API", { ...this.options.onWarn === void 0 ? {} : { onWarn: this.options.onWarn } });
			if (response.body === null) throw new LlmError("copilot API returned no response body", EMPTY_RESPONSE_CODE);
			const pulse = () => {
				watchdog.pulse();
			};
			if (wire === "responses") {
				const normalizer = new CopilotResponsesItemNormalizer((callIds, items) => {
					this.captureReasoning(scope, callIds, items);
				});
				yield* streamResponses(response.body, pulse, (event) => normalizer.push(event));
			} else yield* streamChatCompletions(response.body, pulse);
		} catch (error) {
			throw mapFetchFailure("copilot API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	async request(options, session, signal, wire, replayScopeKey) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const hasVision = messages.some((message) => message.content.some((block) => block.type === "image"));
		const body = wire === "responses" ? copilotResponsesRequestBody(options, toResponsesInput(messages, options.system, (callId) => this.replayFor(replayScopeKey, callId))) : copilotChatRequestBody(options, toChatMessages(messages, options.system));
		return proxiedFetch(wire === "responses" ? COPILOT_RESPONSES_URL : COPILOT_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"accept": "text/event-stream",
				"content-type": "application/json",
				...copilotHeaders(hasVision, await latestVsCodeVersion(this.options.fetchFn ?? proxiedFetch))
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion
//#region src/tools/x-search.ts
/** Endpoint the search request is posted to. */
const X_SEARCH_URL = "https://api.x.ai/v1/responses";
/** Grok model the search runs on (a catalog model of the grok provider). */
const X_SEARCH_MODEL = "grok-4";
/** xAI caps each handle filter list at ten entries. */
const MAX_HANDLES = 10;
/**
* Validate and assemble the request facts from tool arguments. Throws plain
* Errors for argument problems the schema DSL cannot express (non-empty
* query, handle caps, mutually exclusive filters).
*/
function buildXSearchRequest(args) {
	const query = args.query.trim();
	if (query.length === 0) throw new Error("x_search: query must be a non-empty string");
	const allowed = normalizeHandles(args.allowed_x_handles, "allowed_x_handles");
	const excluded = normalizeHandles(args.excluded_x_handles, "excluded_x_handles");
	if (allowed.length > 0 && excluded.length > 0) throw new Error("x_search: allowed_x_handles and excluded_x_handles cannot be used together");
	const tool = { type: "x_search" };
	if (allowed.length > 0) tool.allowed_x_handles = allowed;
	if (excluded.length > 0) tool.excluded_x_handles = excluded;
	if (args.from_date !== void 0 && args.from_date.trim().length > 0) tool.from_date = args.from_date.trim();
	if (args.to_date !== void 0 && args.to_date.trim().length > 0) tool.to_date = args.to_date.trim();
	if (args.enable_image_understanding === true) tool.enable_image_understanding = true;
	if (args.enable_video_understanding === true) tool.enable_video_understanding = true;
	return {
		query,
		tool
	};
}
/** Strip `@` prefixes, drop blanks, and enforce the provider's handle cap. */
function normalizeHandles(value, field) {
	if (value === void 0) return [];
	const handles = value.map((handle) => handle.trim().replace(/^@+/, "")).filter((handle) => handle.length > 0);
	if (handles.length > MAX_HANDLES) throw new Error(`x_search: ${field} supports at most ${MAX_HANDLES} handles`);
	return handles;
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Extract the answer text and citation URLs from a Responses payload: the
* `output_text` shortcut or message output parts for the answer, and both
* top-level `citations` and inline `url_citation` annotations for sources.
*/
function parseXSearchResponse(payload) {
	const body = isRecord$1(payload) ? payload : {};
	let answer = typeof body.output_text === "string" ? body.output_text.trim() : "";
	const citations = [];
	const push = (url) => {
		if (typeof url === "string" && url.length > 0 && !citations.includes(url)) citations.push(url);
	};
	if (Array.isArray(body.citations)) for (const citation of body.citations) push(citation);
	const parts = [];
	if (Array.isArray(body.output)) for (const item of body.output) {
		if (!isRecord$1(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (!isRecord$1(part)) continue;
			if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string" && part.text.trim().length > 0) parts.push(part.text.trim());
			if (Array.isArray(part.annotations)) {
				for (const annotation of part.annotations) if (isRecord$1(annotation) && annotation.type === "url_citation") push(annotation.url);
			}
		}
	}
	if (answer.length === 0) answer = parts.join("\n\n");
	return {
		answer,
		citations
	};
}
/** Bound a call-card title's query. */
function truncate$2(text, max = 60) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/**
* Build the `x_search` tool definition.
* @param options - grok session source and fetch implementation.
* @returns the tool to register on `ctx.tools`.
*/
function createXSearchTool(options) {
	return defineTool({
		name: "x_search",
		description: "Search X (Twitter) posts, profiles, and threads using the grok subscription's hosted xAI x_search. Use this for current discussion, reactions, or claims on X rather than general web pages.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "What to look up on X."
			},
			allowed_x_handles: {
				type: "array",
				items: { type: "string" },
				description: "X handles to include exclusively (max 10)."
			},
			excluded_x_handles: {
				type: "array",
				items: { type: "string" },
				description: "X handles to exclude (max 10)."
			},
			from_date: {
				type: "string",
				description: "Optional start date in YYYY-MM-DD format."
			},
			to_date: {
				type: "string",
				description: "Optional end date in YYYY-MM-DD format."
			},
			enable_image_understanding: {
				type: "boolean",
				description: "Whether xAI should analyze images attached to matching posts."
			},
			enable_video_understanding: {
				type: "boolean",
				description: "Whether xAI should analyze videos attached to matching posts."
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					answer: {
						type: "string",
						required: true
					},
					citations: {
						type: "array",
						items: { type: "string" },
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: value.citations.length > 0 ? `${value.answer}\n\nSources:\n${value.citations.map((citation) => `- ${citation}`).join("\n")}` : value.answer
			}],
			presentationMeta: (_args, value) => ({
				answer: value.answer,
				citations: value.citations
			})
		},
		presentCall: (args) => ({
			card: "generic",
			title: `x_search: ${truncate$2(args.query)}`,
			kind: "search"
		}),
		presentResult: (_args, result) => {
			if (result.isError || !isRecord$1(result.meta)) return void 0;
			return {
				card: "web",
				kind: "search",
				sources: (Array.isArray(result.meta.citations) ? result.meta.citations : []).filter((citation) => typeof citation === "string").map((url) => ({ url })),
				...typeof result.meta.answer === "string" && result.meta.answer.length > 0 ? { answer: result.meta.answer } : {},
				truncated: false
			};
		},
		async execute(args, exec) {
			const request = buildXSearchRequest(args);
			const session = await options.tokens.session();
			const response = await (options.fetchFn ?? proxiedFetch)(X_SEARCH_URL, {
				method: "POST",
				headers: {
					"authorization": `Bearer ${session.accessToken}`,
					"content-type": "application/json",
					"accept": "application/json"
				},
				body: JSON.stringify({
					model: X_SEARCH_MODEL,
					input: [{
						role: "user",
						content: request.query
					}],
					tools: [request.tool],
					store: false
				}),
				signal: exec.signal
			});
			if (!response.ok) throw await httpLlmError(response, "x_search");
			return parseXSearchResponse(await response.json());
		}
	});
}

//#endregion
//#region src/tools/image-generate.ts
/** Endpoint the codex generation request is posted to. */
const IMAGE_GENERATE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const IMAGE_EDIT_URL = "https://chatgpt.com/backend-api/codex/images/edits";
/** The image model the codex subscription endpoint serves. */
const IMAGE_GENERATE_MODEL = "gpt-image-2";
/** Endpoint the grok generation request is posted to. */
const GROK_IMAGE_GENERATE_URL = "https://api.x.ai/v1/images/generations";
const GROK_IMAGE_EDIT_URL = "https://api.x.ai/v1/images/edits";
/** The image model the grok subscription endpoint serves. */
const GROK_IMAGE_GENERATE_MODEL = "grok-imagine-image-2.0";
/** Resolve references before any upstream request; never silently generate on invalid edits. */
async function resolveReferenceImages(refs, attachments, signal) {
	if (refs === void 0) return void 0;
	if (!Array.isArray(refs) || refs.length < 1 || refs.length > 5) throw new Error("image_generate: referenceImages must contain 1–5 complete image references; omit only for a new image");
	if (attachments === void 0) throw new Error("image_generate: editing requires the DSH attachment service");
	const seen = /* @__PURE__ */ new Set();
	let totalBytes = 0;
	const urls = [];
	for (const ref of refs) {
		signal.throwIfAborted();
		if (ref === null || typeof ref !== "object" || typeof ref.attachmentId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) || ![
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/gif"
		].includes(ref.mediaType) || ![
			ref.bytes,
			ref.width,
			ref.height
		].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("image_generate: invalid referenceImages entry; copy a complete image reference or call read_image for a local file. Do not omit references to retry an edit.");
		if (seen.has(ref.attachmentId)) throw new Error("image_generate: referenceImages contains duplicate images");
		seen.add(ref.attachmentId);
		if (refs.length > attachments.imageLimits.maxImagesPerMessage || ref.bytes > attachments.imageLimits.maxImageBytes || totalBytes + ref.bytes > attachments.imageLimits.maxMessageImageBytes) throw new Error("image_generate: referenceImages exceed DSH image limits");
		const stored = await attachments.readImage(imageRefFromValue(ref), signal);
		totalBytes += stored.data.byteLength;
		if (totalBytes > attachments.imageLimits.maxMessageImageBytes) throw new Error("image_generate: referenceImages exceed DSH image limits");
		urls.push(`data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`);
	}
	return urls;
}
/**
* Assemble the codex request body from tool arguments (hand-checks the
* non-empty prompt the schema DSL cannot express).
*/
function buildImageGenerateBody(args) {
	const prompt = args.prompt.trim();
	if (prompt.length === 0) throw new Error("image_generate: prompt must be a non-empty string");
	return {
		prompt,
		model: IMAGE_GENERATE_MODEL,
		...args.size === void 0 ? {} : { size: args.size },
		...args.quality === void 0 ? {} : { quality: args.quality }
	};
}
/** The codex `size` values mapped onto grok aspect ratios. */
const GROK_ASPECT_RATIOS = {
	"1024x1024": "1:1",
	"1024x1536": "2:3",
	"1536x1024": "3:2",
	"auto": "auto"
};
/**
* Assemble the grok request body from the same tool arguments: `size` maps
* onto the nearest `aspect_ratio`, and `quality` folds into grok's low/medium
* pair (`high` → `medium`, `auto` → provider default).
*/
function buildGrokImageGenerateBody(args) {
	const prompt = args.prompt.trim();
	if (prompt.length === 0) throw new Error("image_generate: prompt must be a non-empty string");
	const quality = args.quality === "low" ? "low" : args.quality === "medium" || args.quality === "high" ? "medium" : void 0;
	return {
		prompt,
		model: GROK_IMAGE_GENERATE_MODEL,
		response_format: "b64_json",
		...args.size === void 0 ? {} : { aspect_ratio: GROK_ASPECT_RATIOS[args.size] },
		...quality === void 0 ? {} : { quality }
	};
}
/**
* Parse the generations response into decodable images. Throws when the
* payload carries no usable `b64_json` entries.
*/
function parseImageGenerateResponse(payload) {
	const body = typeof payload === "object" && payload !== null ? payload : {};
	const entries = Array.isArray(body.data) ? body.data : [];
	const images = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		if (typeof record.b64_json !== "string" || record.b64_json.length === 0) continue;
		images.push({
			data: Buffer.from(record.b64_json, "base64"),
			...typeof record.revised_prompt === "string" && record.revised_prompt.length > 0 ? { revisedPrompt: record.revised_prompt } : {}
		});
	}
	if (images.length === 0) throw new Error("image_generate: the response carried no image data");
	return images;
}
/** Directory the generated image files are written to. */
function imagesDirectory() {
	return dshHomePath("plugins", "airules-subscriptions", "images");
}
/**
* Sniff a generated image's media type from its magic bytes (codex serves
* PNG; grok's format is undocumented, so trust the bytes). Unrecognized data
* defaults to PNG, matching the historical behavior.
*/
function sniffImageMediaType(data) {
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return "image/png";
}
/** File extension for one sniffed media type. */
const MEDIA_TYPE_EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp"
};
/** Timestamped, collision-safe file name for one generated image. */
function imageFileName(index, mediaType) {
	return `image-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}-${index}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`;
}
/** Bound a call-card title's prompt. */
function truncate$1(text, max = 60) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/**
* Non-throwing image-capability check for the calling route (read_image's
* gate, softened: a generated image that cannot enter history degrades to the
* text-only result instead of failing the call). Resolves the session's
* latest routed provider/model and answers whether the exact route declares
* image input; any resolution failure means "no".
*/
async function routeDeclaresImageInput(resolveLlm, exec) {
	const llm$1 = resolveLlm?.();
	const routed = exec.agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? exec.agent?.options.provider;
	const model = routed?.model ?? exec.agent?.options.model;
	if (llm$1 === void 0 || provider === void 0 || model === void 0) return false;
	try {
		return (await llm$1.resolveModelInfo(provider, model, exec.signal)).inputModalities?.includes("image") === true;
	} catch {
		return false;
	}
}
/** Re-brand one canonical image entry into the attachment reference an ImageBlock carries. */
function imageRefFromValue(image) {
	return {
		attachmentId: AttachmentId(image.attachmentId),
		mediaType: image.mediaType,
		bytes: image.bytes,
		width: image.width,
		height: image.height,
		...image.name === void 0 ? {} : { name: image.name },
		...image.originalDimensions === void 0 ? {} : { originalDimensions: image.originalDimensions }
	};
}
/** Project the canonical value into the model-facing text + image blocks. */
function imageGenerateContent(value) {
	return [imageGenerateText(value), ...(value.images ?? []).map((image) => ({
		type: "image",
		attachment: imageRefFromValue(image)
	}))];
}
/** The text summary of one generation, shared by the model content and the UI card. */
function imageGenerateText(value) {
	return {
		type: "text",
		text: `Saved ${value.paths.length} image(s):\n${value.paths.map((path) => `- ${path}`).join("\n")}` + (value.images?.length ? `\n\nImage references (for image_generate.referenceImages): ${JSON.stringify(value.images)}` : "") + (value.revisedPrompt === void 0 ? "" : `\n\nRevised prompt: ${value.revisedPrompt}`)
	};
}
/**
* Build the `image_generate` tool definition.
* @param options - codex session source, fetch implementation, and image directory.
* @returns the tool to register on `ctx.tools`.
*/
function createImageGenerateTool(options) {
	const imagePool = options.imagePool ?? new ImageAccountPool();
	return defineTool({
		name: "image_generate",
		description: "Generate an image with the ChatGPT subscription (gpt-image-2) or the Grok subscription (grok-imagine-image-2.0) and save it as an image file. The `provider` parameter picks the preferred provider (default gpt); when the preferred one is logged out the other serves as fallback. Within the selected provider, image requests use available subscription accounts; quota or authentication rejection can switch accounts without changing providers. Returns the saved file paths; on image-capable models the image itself is attached. To edit or use existing images as references, pass referenceImages copied from the image reference text or structured tool results (read_image.image or image_generate.images). Select only the images the user intends, in prompt order. For local files, call read_image first. Omit referenceImages only for a new image. If an edit reference fails, fix it and retry; never omit it to substitute text-to-image generation.",
		parameters: {
			referenceImages: {
				type: "array",
				description: "Optional 1–5 ordered complete DSH image references to edit or use as source images. Not file paths or URLs. Omit only for new images.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						attachmentId: {
							type: "string",
							required: true
						},
						mediaType: {
							type: "string",
							enum: [
								"image/png",
								"image/jpeg",
								"image/webp",
								"image/gif"
							],
							required: true
						},
						bytes: {
							type: "integer",
							required: true
						},
						width: {
							type: "integer",
							required: true
						},
						height: {
							type: "integer",
							required: true
						},
						name: { type: "string" },
						originalDimensions: {
							type: "object",
							additionalProperties: false,
							properties: {
								width: {
									type: "integer",
									required: true
								},
								height: {
									type: "integer",
									required: true
								}
							}
						}
					}
				}
			},
			prompt: {
				type: "string",
				required: true,
				description: "What the image should show."
			},
			size: {
				type: "string",
				enum: [
					"1024x1024",
					"1024x1536",
					"1536x1024",
					"auto"
				],
				description: "Image dimensions; omit for the provider default."
			},
			quality: {
				type: "string",
				enum: [
					"low",
					"medium",
					"high",
					"auto"
				],
				description: "Rendering quality; omit for the provider default."
			},
			provider: {
				type: "string",
				enum: ["gpt", "grok"],
				description: "Preferred provider (default gpt); the other one serves as fallback when the preferred is logged out."
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					paths: {
						type: "array",
						items: { type: "string" },
						required: true
					},
					images: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								attachmentId: {
									type: "string",
									required: true
								},
								mediaType: {
									type: "string",
									enum: [
										"image/png",
										"image/jpeg",
										"image/webp",
										"image/gif"
									],
									required: true
								},
								bytes: {
									type: "integer",
									required: true
								},
								width: {
									type: "integer",
									required: true
								},
								height: {
									type: "integer",
									required: true
								},
								name: { type: "string" }
							}
						}
					},
					revisedPrompt: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => imageGenerateContent(value)
		},
		presentCall: (args) => ({
			card: "generic",
			title: `image_generate${args.referenceImages === void 0 ? "" : ` (edit, ${args.referenceImages.length} images)`}: ${truncate$1(args.prompt)}`
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			content: result.content.filter((block) => block.type === "text")
		}),
		async execute(args, exec) {
			const fetchFn = options.fetchFn ?? proxiedFetch;
			buildImageGenerateBody(args);
			const references = await resolveReferenceImages(args.referenceImages, options.resolveAttachments?.(), exec.signal);
			const preferGrok = args.provider === "grok";
			const createdAt = exec.agent?.session.header?.createdAt;
			const codexEnabled = options.providerEnabled?.("codex", createdAt) !== false;
			const grokEnabled = options.providerEnabled?.("grok", createdAt) !== false;
			const codexReady = codexEnabled && options.codexTokens !== void 0 && (await options.codexTokens.list()).length > 0;
			const grokReady = grokEnabled && options.grokTokens !== void 0 && (await options.grokTokens.list()).length > 0;
			const useGrok = preferGrok ? grokReady : grokReady && !codexReady;
			const useCodex = !useGrok && codexReady;
			let response;
			if (useCodex && options.codexTokens !== void 0) response = await imagePool.request({
				provider: "codex",
				consume: response => response.json(),
				tokens: options.codexTokens,
				signal: exec.signal,
				owner: exec.agent?.session,
				rateLimitReset: codexRateLimitReset,
				send: (session) => fetchFn(references === void 0 ? IMAGE_GENERATE_URL : IMAGE_EDIT_URL, {
					method: "POST",
					headers: {
						"authorization": `Bearer ${session.accessToken}`,
						"chatgpt-account-id": session.accountId,
						"originator": "codex_cli_rs",
						"content-type": "application/json",
						"accept": "application/json"
					},
					body: JSON.stringify({
						...buildImageGenerateBody(args),
						...references === void 0 ? {} : { images: references.map((image_url) => ({ image_url })) }
					}),
					signal: exec.signal
				})
			});
			else if (useGrok && options.grokTokens !== void 0) response = await imagePool.request({
				provider: "grok",
				consume: response => response.json(),
				tokens: options.grokTokens,
				signal: exec.signal,
				owner: exec.agent?.session,
				rateLimitReset: grokRateLimitReset,
				send: (session) => fetchFn(references === void 0 ? GROK_IMAGE_GENERATE_URL : GROK_IMAGE_EDIT_URL, {
					method: "POST",
					headers: {
						"authorization": `Bearer ${session.accessToken}`,
						"content-type": "application/json",
						"accept": "application/json"
					},
					body: JSON.stringify({
						...buildGrokImageGenerateBody(args),
						...references === void 0 ? {} : references.length === 1 ? { image: {
							type: "image_url",
							url: references[0]
						} } : { images: references.map((url) => ({
							type: "image_url",
							url
						})) }
					}),
					signal: exec.signal
				})
			});
			else {
				if (!codexEnabled && !grokEnabled) throw new Error("image_generate: disabled for this session");
				const codex = codexEnabled ? options.codexTokens : void 0;
				const grok = grokEnabled ? options.grokTokens : void 0;
				const manager = preferGrok ? grok ?? codex : codex ?? grok;
				if (manager === void 0) throw new Error("image_generate: no image provider is configured");
				await manager.session();
				throw new Error("image_generate: no image provider is logged in");
			}
			const images = parseImageGenerateResponse(response);
			const directory = options.imagesDir ?? imagesDirectory();
			await mkdir(directory, { recursive: true });
			const paths = [];
			const mediaTypes = [];
			for (const [index, image] of images.entries()) {
				const mediaType = sniffImageMediaType(image.data);
				const path = join(directory, imageFileName(index, mediaType));
				await writeFile(path, image.data);
				paths.push(path);
				mediaTypes.push(mediaType);
			}
			const attachments = options.resolveAttachments?.();
			const imageCapable = attachments !== void 0 && await routeDeclaresImageInput(options.resolveLlm, exec);
			const refs = [];
			if (attachments !== void 0 && imageCapable) for (const [index, image] of images.entries()) {
				const ref = await attachments.saveImage({
					data: image.data,
					mediaType: mediaTypes[index],
					name: basename(paths[index])
				});
				refs.push({
					attachmentId: ref.attachmentId,
					mediaType: ref.mediaType,
					bytes: ref.bytes,
					width: ref.width,
					height: ref.height,
					...ref.name === void 0 ? {} : { name: ref.name }
				});
			}
			const revisedPrompt = images.find((image) => image.revisedPrompt !== void 0)?.revisedPrompt;
			return {
				paths,
				...refs.length > 0 ? { images: refs } : {},
				...revisedPrompt === void 0 ? {} : { revisedPrompt }
			};
		}
	});
}

//#endregion
//#region src/tools/video-generate.ts
/** Endpoint the generation request is posted to. */
const VIDEO_GENERATE_URL = "https://api.x.ai/v1/videos/generations";
/** The video model the grok subscription endpoint serves. */
const VIDEO_GENERATE_MODEL = "grok-imagine-video-1.5";
/** Polling endpoint for one generation request. */
function videoStatusUrl(requestId) {
	return `https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`;
}
/** Default delay between two status polls. */
const DEFAULT_POLL_INTERVAL_MS = 3e3;
/** Default overall deadline for one generation (submit → done). */
const DEFAULT_MAX_WAIT_MS = 10 * 6e4;
/** xAI's supported clip length range in seconds. */
const DURATION_RANGE = {
	min: 1,
	max: 15
};
/**
* Assemble the request body from tool arguments (hand-checks the non-empty
* prompt and the duration range the schema DSL cannot express).
*/
function buildVideoGenerateBody(args) {
	const prompt = args.prompt.trim();
	if (prompt.length === 0) throw new Error("video_generate: prompt must be a non-empty string");
	if (args.duration !== void 0 && (!Number.isInteger(args.duration) || args.duration < DURATION_RANGE.min || args.duration > DURATION_RANGE.max)) throw new Error(`video_generate: duration must be an integer between ${String(DURATION_RANGE.min)} and ${String(DURATION_RANGE.max)} seconds`);
	const imageUrl = args.image_url?.trim();
	return {
		prompt,
		model: VIDEO_GENERATE_MODEL,
		...args.duration === void 0 ? {} : { duration: args.duration },
		...args.aspect_ratio === void 0 ? {} : { aspect_ratio: args.aspect_ratio },
		...args.resolution === void 0 ? {} : { resolution: args.resolution },
		...imageUrl === void 0 || imageUrl.length === 0 ? {} : { image: { url: imageUrl } }
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Extract the request id from the submit response. Throws when the payload
* carries none.
*/
function parseVideoStartResponse(payload) {
	const body = isRecord(payload) ? payload : {};
	if (typeof body.request_id !== "string" || body.request_id.length === 0) throw new Error("video_generate: the response carried no request_id");
	return body.request_id;
}
/**
* Decode one poll response. A `done` payload without a video URL and an
* unrecognized status both throw (the poll loop cannot make progress on
* either).
*/
function parseVideoStatusResponse(payload) {
	const body = isRecord(payload) ? payload : {};
	switch (body.status) {
		case "pending": return { status: "pending" };
		case "done": {
			const video = isRecord(body.video) ? body.video : {};
			if (typeof video.url !== "string" || video.url.length === 0) throw new Error("video_generate: the completed response carried no video URL");
			return {
				status: "done",
				url: video.url,
				...typeof video.duration === "number" ? { duration: video.duration } : {}
			};
		}
		case "failed":
		case "expired": {
			const error = isRecord(body.error) ? body.error : {};
			const detail = typeof error.message === "string" && error.message.length > 0 ? error.message : typeof body.error === "string" && body.error.length > 0 ? body.error : void 0;
			return {
				status: body.status,
				...detail === void 0 ? {} : { detail }
			};
		}
		default: throw new Error(`video_generate: unexpected status ${JSON.stringify(body.status)}`);
	}
}
/** Directory the downloaded MP4 files are written to. */
function videosDirectory() {
	return dshHomePath("plugins", "airules-subscriptions", "videos");
}
/** Timestamped, collision-safe file name for one generated video. */
function videoFileName() {
	return `video-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.mp4`;
}
/** Bound a call-card title's prompt. */
function truncate(text, max = 60) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/** Abort-aware sleep between two polls. */
function sleep(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("video_generate: aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Build the `video_generate` tool definition.
* @param options - grok session source, fetch implementation, and video directory.
* @returns the tool to register on `ctx.tools`.
*/
function createVideoGenerateTool(options) {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	return defineTool({
		name: "video_generate",
		description: `Generate a short video (1-15 seconds) with the grok subscription (${VIDEO_GENERATE_MODEL}) and save it as an MP4 file. Generation is asynchronous and may take a minute or more; the tool waits for completion and returns the saved file path. Optionally animate a still image by passing image_url (image-to-video).`,
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "What the video should show."
			},
			duration: {
				type: "integer",
				description: "Clip length in seconds (1-15); omit for the provider default."
			},
			aspect_ratio: {
				type: "string",
				enum: [
					"16:9",
					"9:16",
					"1:1",
					"4:3",
					"3:4",
					"3:2",
					"2:3"
				],
				description: "Output aspect ratio; omit for the provider default (16:9)."
			},
			resolution: {
				type: "string",
				enum: [
					"480p",
					"720p",
					"1080p"
				],
				description: "Output resolution; omit for the provider default (480p). Higher is slower."
			},
			image_url: {
				type: "string",
				description: "Optional public URL or base64 data URL of a JPEG/PNG/WebP image to animate (image-to-video); the image becomes the starting frame."
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					duration: { type: "number" }
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: `Saved video to ${value.path}` + (value.duration === void 0 ? "" : ` (${String(value.duration)}s)`) + `\nTemporary provider URL (expires soon): ${value.url}`
			}],
			presentationMeta: (_args, value) => ({
				fileName: basename(value.path),
				...value.duration === void 0 ? {} : { duration: value.duration }
			})
		},
		presentCall: (args) => ({
			card: "generic",
			title: `video_generate: ${truncate(args.prompt)}`
		}),
		async execute(args, exec) {
			const body = buildVideoGenerateBody(args);
			const session = await options.tokens.session();
			const fetchFn = options.fetchFn ?? proxiedFetch;
			const headers = {
				"authorization": `Bearer ${session.accessToken}`,
				"accept": "application/json"
			};
			const submit = await fetchFn(VIDEO_GENERATE_URL, {
				method: "POST",
				headers: {
					...headers,
					"content-type": "application/json"
				},
				body: JSON.stringify(body),
				signal: exec.signal
			});
			if (!submit.ok) throw await httpLlmError(submit, "video_generate");
			const requestId = parseVideoStartResponse(await submit.json());
			const deadline = Date.now() + maxWaitMs;
			let done;
			for (;;) {
				await sleep(pollIntervalMs, exec.signal);
				const poll = await fetchFn(videoStatusUrl(requestId), {
					method: "GET",
					headers,
					signal: exec.signal
				});
				if (!poll.ok) throw await httpLlmError(poll, "video_generate");
				const status = parseVideoStatusResponse(await poll.json());
				if (status.status === "done") {
					done = status;
					break;
				}
				if (status.status === "failed" || status.status === "expired") throw new Error(`video_generate: generation ${status.status} (request ${requestId})` + (status.detail === void 0 ? "" : `: ${status.detail}`));
				if (Date.now() >= deadline) throw new Error(`video_generate: timed out after ${String(maxWaitMs)}ms waiting for request ${requestId}`);
			}
			const download = await fetchFn(done.url, {
				method: "GET",
				signal: exec.signal
			});
			if (!download.ok) throw await httpLlmError(download, "video_generate download");
			const data = Buffer.from(await download.arrayBuffer());
			const directory = options.videosDir ?? videosDirectory();
			await mkdir(directory, { recursive: true });
			const path = join(directory, videoFileName());
			await writeFile(path, data);
			return {
				path,
				url: done.url,
				...done.duration === void 0 ? {} : { duration: done.duration }
			};
		}
	});
}

//#endregion
//#region src/provider-settings.ts
const PROVIDER_TOOLS = {
	cursor: [],
	codex: ["image_generate"],
	claude: [],
	grok: [
		"image_generate",
		"video_generate",
		"x_search"
	],
	copilot: []
};
function validatePreferences(provider, input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("settings must be an object");
	const raw = input;
	const result = {};
	if (raw.defaultModels !== void 0) {
		if (provider !== "cursor" || !raw.defaultModels || typeof raw.defaultModels !== "object" || Array.isArray(raw.defaultModels)) throw new Error("defaultModels must be a Cursor model-to-selector map");
		result.defaultModels = Object.create(null);
		for (const [model, selector] of Object.entries(raw.defaultModels)) {
			if (!model.trim() || typeof selector !== "string" || !selector.trim()) throw new Error("model defaults must name an exact catalog selector");
			result.defaultModels[model] = selector;
		}
	}
	if (raw.visibleModels !== void 0) {
		if (!Array.isArray(raw.visibleModels) || raw.visibleModels.some((id) => typeof id !== "string" || !id.trim())) throw new Error("visibleModels must be an array of model ids");
		result.visibleModels = [...new Set(raw.visibleModels)];
	}
	if (raw.contextWindows !== void 0) {
		if (provider !== "codex") throw new Error("context window overrides are currently supported only for Codex");
		if (!raw.contextWindows || typeof raw.contextWindows !== "object" || Array.isArray(raw.contextWindows)) throw new Error("contextWindows must be a model-to-token map");
		result.contextWindows = Object.create(null);
		for (const [model, value] of Object.entries(raw.contextWindows)) {
			if (!model.trim() || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("context windows must be positive safe integers");
			result.contextWindows[model] = value;
		}
	}
	if (raw.tools !== void 0) {
		if (!raw.tools || typeof raw.tools !== "object" || Array.isArray(raw.tools)) throw new Error("tools must be an object");
		result.tools = {};
		for (const [tool, enabled] of Object.entries(raw.tools)) {
			if (!PROVIDER_TOOLS[provider].includes(tool) || typeof enabled !== "boolean") throw new Error(`unsupported tool setting: ${provider}/${tool}`);
			result.tools[tool] = enabled;
		}
	}
	// dsh1c-r228: the catalog a manual selection was saved against.
	if (raw.knownModels !== void 0) {
		if (!Array.isArray(raw.knownModels) || raw.knownModels.some((id) => typeof id !== "string" || !id.trim())) throw new Error("knownModels must be an array of model ids");
		result.knownModels = [...new Set(raw.knownModels)];
	}
	return result;
}
/** Durable user preferences, independent of expiring discovery caches. */
var ProviderSettingsStore = class {
	current = {
		providers: {},
		toolHistory: []
	};
	writes = Promise.resolve();
	path;
	constructor(path = dshHomePath("plugins", "airules-subscriptions", "provider-settings.json")) {
		this.path = path;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (!raw.providers || !Array.isArray(raw.toolHistory)) throw new Error("invalid settings document");
			for (const provider of [...PROVIDER_IDS, "cursor"]) if (Object.hasOwn(raw.providers, provider)) this.current.providers[provider] = validatePreferences(provider, raw.providers[provider]);
			this.current.toolHistory = raw.toolHistory.map((revision) => {
				if (!PROVIDER_IDS.includes(revision.provider) || !Number.isSafeInteger(revision.at) || revision.at < 0) throw new Error("invalid tool history");
				const tools = validatePreferences(revision.provider, { tools: revision.tools }).tools ?? {};
				return {
					at: revision.at,
					provider: revision.provider,
					tools
				};
			}).sort((a, b) => a.at - b.at);
		} catch (error) {
			if (error.code !== "ENOENT") throw new Error(`Cannot read provider settings at ${path}`, { cause: error });
		}
	}
	get(provider) {
		return structuredClone(this.current.providers[provider] ?? {});
	}
	visible(provider, model) {
		const { visibleModels, knownModels } = this.current.providers[provider] ?? {};
		if (!Array.isArray(visibleModels) || visibleModels.includes(model)) return true;
		// dsh1c-r228: an explicit empty selection hides everything; otherwise a model the catalog gained after the
		// selection was saved stays visible, and a selection none of whose models is still offered shows the catalog.
		if (visibleModels.length === 0) return false;
		const catalog = this.observedCatalogs?.get(provider);
		if (catalog !== void 0 && catalog.length > 0 && !visibleModels.some((id) => catalog.includes(id))) return true;
		return Array.isArray(knownModels) && !knownModels.includes(model);
	}
	/** dsh1c-r228: the provider's latest full catalog, recorded by every model listing. */
	observeCatalog(provider, ids) {
		(this.observedCatalogs ??= /* @__PURE__ */ new Map()).set(provider, [...ids]);
	}
	contextWindow(model) {
		const windows = this.current.providers.codex?.contextWindows;
		return windows && Object.hasOwn(windows, model) ? windows[model] : void 0;
	}
	/** Creation-time policy survives restarts and never changes an existing session. */
	toolEnabled(provider, tool, createdAt = Date.now()) {
		let enabled = true;
		for (const revision of this.current.toolHistory) {
			if (revision.at > createdAt) break;
			if (revision.provider === provider) enabled = revision.tools[tool] !== false;
		}
		return enabled;
	}
	set(provider, input) {
		const preferences = validatePreferences(provider, input);
		// dsh1c-r228: a manual selection remembers the catalog it was made from; re-saving the same selection keeps it.
		if (Array.isArray(preferences.visibleModels)) {
			const previous = this.current.providers[provider];
			const unchanged = Array.isArray(previous?.visibleModels) && previous.visibleModels.length === preferences.visibleModels.length && previous.visibleModels.every((id) => preferences.visibleModels.includes(id));
			const catalog = this.observedCatalogs?.get(provider);
			if (unchanged && Array.isArray(previous.knownModels)) preferences.knownModels = previous.knownModels;
			else if (catalog !== void 0 && catalog.length > 0) preferences.knownModels = [...new Set([...catalog, ...preferences.visibleModels])];
		} else delete preferences.knownModels;
		const run = this.writes.then(async () => {
			const next = structuredClone(this.current);
			const before = next.providers[provider]?.tools ?? {};
			next.providers[provider] = preferences;
			if (PROVIDER_TOOLS[provider].some((tool) => before[tool] !== false !== (preferences.tools?.[tool] !== false))) next.toolHistory.push({
				at: Date.now(),
				provider,
				tools: preferences.tools ?? {}
			});
			await mkdir(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 384 });
				await rename(temporary, this.path);
			} finally {
				await rm(temporary, { force: true });
			}
			this.current = next;
		});
		this.writes = run.catch(() => void 0);
		return run;
	}
};

//#endregion
//#region src/index.ts
let sharedPreferences;
function getProviderSettingsStore() { return sharedPreferences ??= new ProviderSettingsStore(); }
const name = "airules-dsh-subscriptions";
const inject = ["llm"];
/** Default maximum provider idle time while one stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
const POOL_USAGE_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS;
const providerIdSchema = z.union([
	"codex",
	"claude",
	"grok",
	"copilot"
]);
const modelEntrySchema = z.object({
	id: z.string().required(),
	name: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	inputModalities: z.array(z.union(["text", "image"])),
	wire: z.union(["chat-completions", "responses"])
});
const poolMemberSchema = z.object({
	provider: providerIdSchema.required(),
	account: z.string(),
	model: z.string().required()
});
const Config = z.object({
	providers: z.array(providerIdSchema).default([
		"codex",
		"claude",
		"grok",
		"copilot"
	]),
	codexClientVersion: z.string(),
	streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	rateLimit: z.object({
		wait: z.boolean().default(true),
		maxWaitMs: z.number().min(1).default(DEFAULT_RATE_LIMIT_MAX_WAIT_MS)
	}),
	models: z.object({
		codex: z.array(modelEntrySchema),
		claude: z.array(modelEntrySchema),
		grok: z.array(modelEntrySchema),
		copilot: z.array(modelEntrySchema)
	}),
	pool: z.object({
		enabled: z.boolean().default(true),
		strategy: z.union(["priority", "quota_aware"]).default("quota_aware"),
		switchMargin: z.number().min(1).default(2),
		autoAccounts: z.boolean().default(true),
		autoFamilies: z.boolean(),
		families: z.dict(z.array(poolMemberSchema)),
		tiers: z.dict(z.array(poolMemberSchema))
	})
});
/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS = {
	codex: [
		{
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex"
		},
		{
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1 Codex Mini"
		},
		{
			id: "gpt-5.1",
			name: "GPT-5.1"
		}
	],
	claude: [
		{
			id: "claude-opus-5",
			name: "Claude Opus 5",
			maxTokens: 128e3,
			contextWindow: 1e6
		},
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			maxTokens: 128e3,
			contextWindow: 1e6
		},
		{
			id: "claude-fable-5",
			name: "Claude Fable 5",
			maxTokens: 128e3,
			contextWindow: 1e6
		},
		{
			id: "claude-haiku-4-5-20251001",
			name: "Claude Haiku 4.5",
			maxTokens: 64e3
		}
	],
	grok: [
		{
			id: "grok-4",
			name: "Grok 4"
		},
		{
			id: "grok-4-fast-reasoning",
			name: "Grok 4 Fast Reasoning"
		},
		{
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1"
		}
	],
	copilot: [
		{
			id: "gpt-4.1",
			name: "GPT-4.1",
			inputModalities: ["text", "image"]
		},
		{
			id: "gpt-4o",
			name: "GPT-4o",
			inputModalities: ["text", "image"]
		},
		{
			id: "claude-sonnet-4.5",
			name: "Claude Sonnet 4.5",
			inputModalities: ["text", "image"]
		},
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			inputModalities: ["text", "image"]
		}
	]
};
/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models) {
	const resolve = (provider) => {
		const configured = models?.[provider];
		return validateModels(configured !== void 0 && configured.length > 0 ? configured : DEFAULT_MODELS[provider], `${name}: models.${provider}`);
	};
	return {
		codex: resolve("codex"),
		claude: resolve("claude"),
		grok: resolve("grok"),
		copilot: resolve("copilot")
	};
}
/** The display account of a stored session, for the status endpoint. */
function accountOf(provider, session) {
	if (session === void 0) return void 0;
	switch (provider) {
		case "codex": {
			const codex = session;
			return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId;
		}
		case "claude": return session.emailAddress;
		case "grok": return session.account;
		case "copilot": return session.account;
	}
}
/** The plan name a stored session carries, when the provider told us. */
function planOf(provider, session) {
	switch (provider) {
		case "codex": return session.planType;
		case "claude": return session.subscriptionType;
		case "grok": return;
		case "copilot": return;
	}
}
/**
* Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
* OAuth attempts in the background, feed pasted codes, cancel, log out, and
* answer usage lookups.
*
* @internal Exported for tests only; not part of the plugin's public surface.
*/
// Read the existing dispatcher's account choice; never claim a lease or send inference.
async function modelUsageForRoute({ provider, model, sessionId, pool, adapters, accountTokens, controller, llm, signal }) {
	if (provider === "cursor") return await llm.registration(provider)?.adapter?.usageForModel?.({ provider, model, sessionId, signal }) ?? { supported: false };
	if (!adapters.has(provider)) return { supported: false };
	let member, basis = "next";
	const definition = pool === void 0 ? void 0 : (await pool.pools()).get(poolKey(provider, model));
	if (definition !== void 0) {
		const members = await pool.concrete(definition.members);
		const previous = pool.sticky.get(stickyKey(model, sessionId));
		member = members.find(row => memberKey(row.provider, row.account, row.model) === previous);
		if (member) basis = "last";
		else member = (await pool.select(model, members, sessionId))[0];
	} else {
		const account = await accountTokens.get(provider)?.defaultAccount();
		if (account !== void 0) member = { provider, model, account };
	}
	if (!member) return { supported: true, provider, unavailable: true };
	const status = await controller.status(member.provider);
	const account = status.accounts.find(row => row.key === member.account);
	if (!account) return { supported: true, provider, unavailable: true };
	const target = { provider: member.provider, account: member.account, accountName: account.account || "Аккаунт", basis };
	try { return { ...await controller.usage(member.provider, member.account, signal), ...target }; }
	catch { return { ...target, supported: true, windows: [], unavailable: true }; }
}

var SubscriptionsAuthController = class {
	/** Last login failure per provider, surfaced as `detail` until the next success. */
	lastError = /* @__PURE__ */ new Map();
	lastLogin = new Map();
	/** Selected account for this login only; never persisted as a credential. */
	loginTargets = new Map();
	/**
	* Device-flow logins whose poll already settled but whose token exchange +
	* persist is still running. Between those two moments the attempt is gone
	* from the flow manager (busy=false) while no session exists yet
	* (loggedIn=false) — counting this window as busy keeps the Settings page
	* polling until the card can show the real outcome.
	*/
	finalizing = /* @__PURE__ */ new Set();
	/** In-flight OAuth completions, one per provider at most. */
	completions = /* @__PURE__ */ new Map();
	/**
	* Per-provider claim counter. Everything that takes ownership of a
	* provider's session — starting a login, importing Claude Code credentials,
	* cancelling, logging out — bumps it, and a session write carrying an older
	* number has been superseded and is dropped.
	*
	* The counter is what makes a late OAuth completion safe: an attempt leaves
	* `OAuthFlowManager`'s pending map the moment its callback delivers the
	* code, while the token exchange that follows can still run for seconds. For
	* that whole window `pending(provider)?.cancel()` is a no-op, so ownership
	* cannot be read off the flow manager.
	*/
	claims = /* @__PURE__ */ new Map();
	constructor(flows, deviceFlows, onAuthChanged, resolveAttachments, usageFetchers = {}, readClaudeCreds = readClaudeCodeCredentials, poolUsage = void 0, accountTokens = new Map(), authStorePath) {
		this.flows = flows;
		this.deviceFlows = deviceFlows;
		this.onAuthChanged = onAuthChanged;
		this.resolveAttachments = resolveAttachments;
		this.usageFetchers = usageFetchers;
		this.readClaudeCreds = readClaudeCreds;
		this.poolUsage = poolUsage;
		this.accountTokens = accountTokens;
		this.authStorePath = authStorePath;
	}
	usage(provider, account, signal, force = false) {
		const fetcher = this.usageFetchers[provider];
		if (fetcher === void 0) return Promise.resolve({ supported: false });
		if (this.poolUsage === void 0) return fetcher(account, signal);
		return this.poolUsage.snapshotFor(provider, account, force);
	}
	async readImage(ref, signal) {
		const attachments = this.resolveAttachments();
		if (attachments === void 0) throw new Error("no attachment service is mounted; generated-image bytes are unavailable");
		const stored = await attachments.readImage(ref, signal);
		return {
			mediaType: stored.ref.mediaType,
			dataBase64: Buffer.from(stored.data).toString("base64")
		};
	}
	async readVideo(name$1, signal) {
		return {
			mediaType: "video/mp4",
			dataBase64: (await readFile(join(videosDirectory(), name$1), { signal })).toString("base64")
		};
	}
	async status(provider) {
		const entries = await listAccounts(provider, this.authStorePath);
		const detail = this.lastError.get(provider);
		return {
			busy: this.flows.isBusy(provider) || this.deviceFlows.isBusy(provider) || this.finalizing.has(provider),
			...(this.loginTargets.has(provider) ? { targetAccount: this.loginTargets.get(provider) } : {}),
			...(this.lastLogin.has(provider) ? { lastLogin: this.lastLogin.get(provider) } : {}),
			accounts: entries.map(({ key, session }, index) => {
				const account = accountOf(provider, session);
				const plan = planOf(provider, session);
				return {
					key,
					isDefault: index === 0,
					...(provider === "codex" ? { enabled: session.enabled !== false } : {}),
					...(provider === "codex" ? { requiresLogin: session.requiresLogin === true } : {}),
					expiresAt: session.expiresAt,
					...account === void 0 ? {} : { account },
					...plan === void 0 ? {} : { plan }
				};
			}),
			...detail === void 0 ? {} : { detail }
		};
	}
	async login(provider, method, account) {
		if (account !== void 0 && (provider !== "codex" || await getAccountSession(provider, account, this.authStorePath) === void 0)) throw new Error("Подписка для повторного входа не найдена. Обновите список подписок.");
		this.lastLogin.delete(provider);
		this.lastError.delete(provider);
		if (provider === "claude" && method === "keychain") {
			const imported = this.readClaudeCreds();
			if (imported !== void 0) {
				this.claim("claude");
				this.flows.pending("claude")?.cancel();
				const session = {
					...imported,
					keychainBound: true
				};
				await this.persist("claude", session);
				this.lastError.delete("claude");
				this.onAuthChanged("claude", accountKeyOf("claude", session));
				return { authorizeUrl: "" };
			}
			if (method === "keychain") throw new Error("no Claude Code credentials found; run `claude` and log in first, or choose the browser flow");
			const attempt$1 = await this.flows.start("claude", claudeFlow);
			this.completions.set("claude", this.complete("claude", attempt$1, this.claim("claude")));
			return { authorizeUrl: attempt$1.authorizeUrl };
		}
		if (provider === "claude") {
			const attempt$1 = await this.flows.start("claude", claudeFlow);
			this.completions.set("claude", this.complete("claude", attempt$1, this.claim("claude")));
			return { authorizeUrl: attempt$1.authorizeUrl };
		}
		if (provider === "copilot") {
			const attempt$1 = await this.deviceFlows.start(provider, copilotDeviceFlow());
			this.finalizing.add(provider);
			this.completeDevice(provider, attempt$1);
			return {
				authorizeUrl: attempt$1.verificationUrl,
				userCode: attempt$1.userCode
			};
		}
		const spec = provider === "grok" ? await grokFlow() : codexFlow;
		const attempt = await this.flows.start(provider, spec);
		if (account === void 0) this.loginTargets.delete(provider);
		else this.loginTargets.set(provider, account);
		this.completions.set(provider, this.complete(provider, attempt, this.claim(provider), account));
		return { authorizeUrl: attempt.authorizeUrl };
	}
	/**
	* Take ownership of a provider's session, superseding every older claim.
	* @param provider - the provider route.
	* @returns the claim number a later write checks itself against.
	*/
	claim(provider) {
		const next = (this.claims.get(provider) ?? 0) + 1;
		this.claims.set(provider, next);
		return next;
	}
	/**
	* Drive one attempt to a stored session; records failures for the status
	* endpoint. The exchange runs unsupervised — the attempt is gone from the
	* flow manager as soon as its code arrives — so the result is stored only
	* while `claim` still owns the provider's session.
	*/
	async complete(provider, attempt, claim, targetAccount) {
		try {
			const code = await attempt.waitCode();
			this.finalizing.add(provider);
			const session = await this.exchange(provider, code, attempt);
			if (this.claims.get(provider) !== claim) return;
			const account = accountKeyOf(provider, session);
			if (targetAccount !== void 0 && account !== targetAccount) throw new Error("Вход выполнен в другой аккаунт. Выбранная подписка не изменена. Войдите в нужный аккаунт или используйте «Добавить аккаунт» для подключения другого.");
			const existing = await getAccountSession(provider, account, this.authStorePath);
			if (this.claims.get(provider) !== claim) return;
			if (targetAccount !== void 0 && existing === void 0) throw new Error("Выбранная подписка уже удалена. Для подключения используйте «Добавить аккаунт».");
			await this.persist(provider, session);
			this.lastError.delete(provider);
			this.lastLogin.set(provider, { account, name: accountOf(provider, session) ?? account, updated: existing !== void 0 });
			this.onAuthChanged(provider, account);
		} catch (error) {
			if (this.claims.get(provider) !== claim) return;
			if (!(error instanceof Error && error.message === "login cancelled")) this.lastError.set(provider, errorChain(error));
		} finally {
			if (this.claims.get(provider) === claim) {
				this.finalizing.delete(provider);
				this.loginTargets.delete(provider);
			}
		}
	}
	/** Drive one device-flow attempt to a stored session (the copilot path of {@link complete}). */
	async completeDevice(provider, attempt) {
		try {
			const session = await completeCopilotLogin(await attempt.waitToken());
			await this.persist(provider, session);
			this.lastError.delete(provider);
			this.onAuthChanged(provider, accountKeyOf(provider, session));
		} catch (error) {
			if (!(error instanceof Error && error.message === "login cancelled")) this.lastError.set(provider, errorChain(error));
		} finally {
			this.finalizing.delete(provider);
		}
	}
	exchange(provider, code, attempt) {
		switch (provider) {
			case "codex": return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri);
			case "claude": return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state);
			case "grok": return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge);
			case "copilot": return Promise.reject(/* @__PURE__ */ new Error("copilot uses the device flow; no authorization code to exchange"));
		}
	}
	persist(provider, session) {
		return saveAccountSession(provider, accountKeyOf(provider, session), session, this.authStorePath);
	}
	/**
	* Settle once no OAuth completion is running for a provider.
	*
	* @internal Exported for tests only: a login's token exchange outlives the
	* `login()` call that started it, and a test asserting on what it stored
	* would otherwise have to guess at a timeout.
	*/
	async settled(provider) {
		await this.completions.get(provider);
	}
	manual(provider, input) {
		const attempt = this.flows.pending(provider);
		if (attempt === void 0) return Promise.reject(/* @__PURE__ */ new Error(`no ${provider} login attempt is in progress`));
		attempt.manual(input);
		return Promise.resolve();
	}
	cancel(provider) {
		this.claim(provider);
		this.finalizing.delete(provider);
		this.loginTargets.delete(provider);
		this.flows.pending(provider)?.cancel();
		this.deviceFlows.pending(provider)?.cancel();
		return Promise.resolve();
	}
	async logout(provider, account) {
		if (provider === "codex" && (this.flows.isBusy(provider) || this.finalizing.has(provider))) throw new Error("Сначала завершите или отмените вход в Codex, затем удалите подключение.");
		if (provider === "codex" && this.accountTokens.get(provider)?.isActive(account)) throw new Error("Подписка сейчас используется. Дождитесь завершения ответа или отмените запрос, затем удалите подключение.");
		this.claim(provider);
		this.flows.pending(provider)?.cancel();
		this.deviceFlows.pending(provider)?.cancel();
		if (provider === "codex" && this.accountTokens.has(provider)) await this.accountTokens.get(provider).removeAccount(account);
		else await deleteAccountSession(provider, account, this.authStorePath);
		if (this.lastLogin.get(provider)?.account === account) this.lastLogin.delete(provider);
		this.finalizing.delete(provider);
		this.loginTargets.delete(provider);
		this.lastError.delete(provider);
		this.onAuthChanged(provider, account);
	}
	async setEnabled(provider, account, enabled) {
		await setAccountEnabled(provider, account, enabled, this.authStorePath);
		this.onAuthChanged(provider, account);
	}
	async setDefault(provider, account) {
		await setDefaultAccount(provider, account, this.authStorePath);
		this.onAuthChanged(provider, account);
	}
};
function apply(ctx, config = {}, host = {}) {
	// Internal host injection only: profiles/UI keep the normal installation store.
	const authStorePath = host.authStorePath;
	if (authStorePath !== void 0 && (typeof authStorePath !== "string" || !isAbsolute(authStorePath))) throw new TypeError("authStorePath must be an absolute path");
	const preferences = getProviderSettingsStore();
	const codexVersion = new CodexClientVersionCache();
	const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])];
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`);
	const rateLimit = resolveRateLimitWait(config.rateLimit, `${name}: rateLimit`);
	const catalog = resolveCatalog(config.models);
	const overridden = new Set(PROVIDER_IDS.filter((provider) => (config.models?.[provider]?.length ?? 0) > 0));
	const flows = new OAuthFlowManager();
	const deviceFlows = new DeviceFlowManager();
	const onWarn = (message) => {
		ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`);
	};
	const resolveAttachments = () => ctx.get("attachments");
	const handles = /* @__PURE__ */ new Map();
	const adapters = /* @__PURE__ */ new Map();
	const accountTokens = /* @__PURE__ */ new Map();
	let poolHealth;
	let poolUsage;
	let poolAdapter;
	const imagePool = new ImageAccountPool({
		enabled: config.pool?.enabled !== false && (config.pool?.autoAccounts ?? config.pool?.autoFamilies ?? true),
		onWarn
	});
	const authChanged = (provider, account) => {
		if (provider === "codex" || provider === "grok") imagePool.clear(provider, account);
		if (provider === "copilot") copilotAdapter?.clearReplayState();
		adapters.get(provider)?.clearAccountCatalog(account);
		poolHealth?.clear(provider, account);
		poolUsage?.invalidate(provider, account);
		poolAdapter?.invalidate();
		for (const [route, handle] of handles) handle.replace([route]);
	};
	loadModelDefaults();
	let codexTokens;
	let claudeTokens;
	let grokTokens;
	const usageFetchers = {};
	const speedBySession = /* @__PURE__ */ new Map();
	let codexAdapter;
	let copilotAdapter;
	for (const provider of providers) switch (provider) {
		case "codex": {
			const tokens = new AccountTokenManager({
				authStorePath,
				provider: "codex",
				displayName: "OpenAI (OAuth)",
				makeOptions: () => ({
					preemptMs: CODEX_PREEMPT_MS,
					refresh: refreshCodex,
					isPermanent: isCodexPermanentRefreshError
				}),
				onAccountRemoved: (account) => {
					authChanged("codex", account);
				}
			});
			codexTokens = tokens;
			accountTokens.set("codex", tokens);
			usageFetchers.codex = async (account, signal) => fetchCodexUsage(await tokens.session(account, false, void 0, true), proxiedFetch, signal);
			let adapter;
			adapter = new CodexAdapter({
				...config.codexClientVersion === void 0 ? {} : { clientVersion: config.codexClientVersion },
				resolveClientVersion: () => codexVersion.resolve(),
				models: catalog.codex,
				streamIdleTimeoutMs,
				rateLimit,
				tokens,
				discovery: !overridden.has("codex"),
				onWarn,
				resolveAttachments,
				catalogStore: catalogStore("codex"),
				defaultEffortOf: () => void 0,
				contextWindowOf: (model) => preferences.contextWindow(model),
				pool: () => poolAdapter,
				speedFor: (sessionId, model) => sessionId !== void 0 && speedBySession.get(sessionId) === "fast" && adapter.supportsFastTier(model)
			});
			codexAdapter = adapter;
			adapters.set("codex", adapter);
			handles.set("codex", ctx.llm.registerAdapter(["codex"], adapter));
			break;
		}
		case "claude": {
			const tokens = new AccountTokenManager({
				authStorePath,
				provider: "claude",
				displayName: "Claude (Subscription)",
				makeOptions: () => ({
					preemptMs: CLAUDE_PREEMPT_MS,
					refresh: (session) => session.keychainBound === true ? refreshClaudeSynced(session, refreshClaude) : refreshClaude(session),
					isPermanent: isClaudePermanentRefreshError
				}),
				onAccountRemoved: (account) => {
					authChanged("claude", account);
				}
			});
			claudeTokens = tokens;
			accountTokens.set("claude", tokens);
			usageFetchers.claude = async (account, signal) => fetchClaudeUsage(await tokens.session(account), proxiedFetch, signal);
			const adapter = new ClaudeAdapter({
				models: catalog.claude,
				streamIdleTimeoutMs,
				rateLimit,
				tokens,
				discovery: !overridden.has("claude"),
				onWarn,
				resolveAttachments,
				catalogStore: catalogStore("claude"),
				defaultEffortOf: (model) => defaultEffortOf("claude", model),
				pool: () => poolAdapter
			});
			adapters.set("claude", adapter);
			handles.set("claude", ctx.llm.registerAdapter(["claude"], adapter));
			break;
		}
		case "grok": {
			const tokens = new AccountTokenManager({
				authStorePath,
				provider: "grok",
				displayName: "Grok (Subscription)",
				makeOptions: () => ({
					preemptMs: GROK_PREEMPT_MS,
					refresh: refreshGrok,
					isPermanent: isGrokPermanentRefreshError
				}),
				onAccountRemoved: (account) => {
					authChanged("grok", account);
				}
			});
			grokTokens = tokens;
			accountTokens.set("grok", tokens);
			usageFetchers.grok = async (account, signal) => fetchGrokUsage(await tokens.session(account), proxiedFetch, signal);
			const adapter = new GrokAdapter({
				models: catalog.grok,
				streamIdleTimeoutMs,
				rateLimit,
				tokens,
				discovery: !overridden.has("grok"),
				onWarn,
				resolveAttachments,
				catalogStore: catalogStore("grok"),
				defaultEffortOf: (model) => defaultEffortOf("grok", model),
				pool: () => poolAdapter
			});
			adapters.set("grok", adapter);
			handles.set("grok", ctx.llm.registerAdapter(["grok"], adapter));
			break;
		}
		case "copilot": {
			const tokens = new AccountTokenManager({
				authStorePath,
				provider: "copilot",
				displayName: "GitHub Copilot",
				makeOptions: () => ({
					preemptMs: COPILOT_PREEMPT_MS,
					refresh: refreshCopilot,
					isPermanent: isCopilotPermanentRefreshError
				}),
				onAccountRemoved: (account) => {
					authChanged("copilot", account);
				}
			});
			accountTokens.set("copilot", tokens);
			copilotAdapter = new CopilotAdapter({
				models: catalog.copilot,
				streamIdleTimeoutMs,
				rateLimit,
				tokens,
				discovery: !overridden.has("copilot"),
				onWarn,
				resolveAttachments,
				catalogStore: catalogStore("copilot"),
				defaultEffortOf: (model) => defaultEffortOf("copilot", model),
				pool: () => poolAdapter
			});
			adapters.set("copilot", copilotAdapter);
			handles.set("copilot", ctx.llm.registerAdapter(["copilot"], copilotAdapter));
			break;
		}
	}
	const poolConfig = config.pool;
	const autoAccounts = poolConfig?.autoAccounts ?? poolConfig?.autoFamilies ?? true;
	if (poolConfig?.enabled !== false && adapters.size >= 1) {
		const fetcherFor = (provider, account) => {
			switch (provider) {
				case "codex": {
					const tokens = codexTokens;
					return tokens === void 0 ? void 0 : async () => fetchCodexUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS));
				}
				case "claude": {
					const tokens = claudeTokens;
					return tokens === void 0 ? void 0 : async () => fetchClaudeUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS));
				}
				case "grok": {
					const tokens = grokTokens;
					return tokens === void 0 ? void 0 : async () => fetchGrokUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS));
				}
				case "copilot": return;
			}
		};
		poolHealth = new PoolHealthRegistry();
		poolUsage = new PoolUsageTracker(fetcherFor);
		const families = async () => {
			const pools = /* @__PURE__ */ new Map();
			if (autoAccounts) {
				const sources = {};
				await Promise.all([...adapters].map(async ([provider, adapter]) => {
					try {
						const accounts = (await accountTokens.get(provider)?.list() ?? []).map((entry) => entry.key);
						if (accounts.length < 2) return;
						const catalogs = (await Promise.all(accounts.map(async (account) => {
							const models = await withTimeout((signal) => adapter.listOwnModels(provider, account, signal), POOL_USAGE_TIMEOUT_MS);
							return models === void 0 ? void 0 : {
								account,
								models
							};
						}))).filter((entry) => entry !== void 0);
						if (catalogs.length >= 2) sources[provider] = { catalogs };
					} catch {}
				}));
				for (const [key, definition] of buildAccountPools(sources)) pools.set(key, definition);
			}
			for (const [id, members] of Object.entries(poolConfig?.families ?? {})) {
				if (members.length === 0) continue;
				const owner = members[0].provider;
				const kept = members.filter((member) => member.provider === owner);
				if (kept.length < members.length) onWarn(`pool "${id}": cross-provider members are ignored; only ${owner} accounts are pooled`);
				pools.set(poolKey(owner, id), { members: kept });
			}
			return pools;
		};
		poolAdapter = new PoolAdapter({
			adapters: Object.fromEntries(adapters),
			health: poolHealth,
			usage: poolUsage,
			strategy: poolConfig?.strategy ?? "quota_aware",
			switchMargin: poolConfig?.switchMargin ?? 2,
			defaultAccount: (provider) => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(void 0),
			families,
			tiers: poolConfig?.tiers ?? {},
			onWarn
		});
	}
	// dsh1c-r228: every listing records the full catalog before the visibility filter judges a manual selection.
	for (const [provider, adapter] of adapters) {
		const own = adapter.listModels.bind(adapter);
		adapter.listModels = async (route) => {
			const models = await own(route);
			preferences.observeCatalog(provider, models.map((model) => model.id));
			return models;
		};
	}
	const fullCatalogs = /* @__PURE__ */ new Map();
	for (const [provider, adapter] of adapters) {
		const list = adapter.listModels.bind(adapter);
		fullCatalogs.set(provider, list);
		adapter.listModels = async (route) => (await list(route)).filter((model) => preferences.visible(provider, model.id));
	}
	const authController = new SubscriptionsAuthController(flows, deviceFlows, authChanged, resolveAttachments, usageFetchers, void 0, poolUsage, accountTokens, authStorePath);
	registerAuthRpc(ctx, authController, {
		modelUsage: (sessionId, provider, model, signal) => modelUsageForRoute({ sessionId, provider, model, signal, pool: poolAdapter, adapters, accountTokens, controller: authController, llm: ctx.llm }),
		async speed(sessionId) {
			return {
				tier: speedBySession.get(sessionId) ?? "standard",
				fastModels: await codexAdapter?.fastCapableModels() ?? []
			};
		},
		async setSpeed(sessionId, tier) {
			if (tier === "standard") speedBySession.delete(sessionId);
			else speedBySession.set(sessionId, tier);
		}
	}, {
		get: () => proxyGetConfig(),
		set: (input) => proxySetConfig(input),
		test: (payload) => proxyTestConnection(payload.url, payload.proxy)
	}, {
		async catalog(force = false) {
			if (force) {
				codexVersion.invalidate();
				for (const adapter of adapters.values()) adapter.clearAccountCatalog();
				poolAdapter?.invalidate();
				for (const [route, handle] of handles) handle.replace([route]);
			}
			const visible = new Set((await ctx.llm.listProviders()).map((provider) => provider.id));
			const catalog$1 = [];
			for (const provider of PROVIDER_IDS) {
				if (!visible.has(provider)) continue;
				let models = [];
				try {
					models = await ctx.llm.listModels(provider);
				} catch {
					continue;
				}
				let tierIds = /* @__PURE__ */ new Set();
				try {
					const tiers = await poolAdapter?.modelsForProvider(provider);
					if (tiers !== void 0) tierIds = new Set(tiers.map((tier) => tier.id));
				} catch {}
				const views = [];
				for (const model of models) {
					if (tierIds.has(model.id)) continue;
					let info;
					try {
						info = await ctx.llm.resolveModelInfo(provider, model.id);
					} catch {
						continue;
					}
					if (info === void 0) continue;
					const override = defaultEffortOf(provider, model.id);
					views.push({
						id: model.id,
						name: model.name,
						efforts: info.reasoning?.efforts.map((effort) => ({
							id: effort.id,
							name: effort.name
						})) ?? [],
						...override === void 0 ? {} : { configured: override }
					});
				}
				catalog$1.push({
					provider,
					models: views
				});
			}
			return catalog$1;
		},
		async set(provider, model, effort) {
			if (effort !== void 0) {
				let info;
				try {
					info = await ctx.llm.resolveModelInfo(provider, model);
				} catch {}
				const offered = info?.reasoning?.efforts ?? [];
				if (offered.length > 0 && !offered.some((entry) => entry.id === effort)) throw new BadRequest(`model ${model} does not advertise a "${effort}" reasoning effort`);
			}
			await setDefaultEffort(provider, model, effort);
			handles.get(provider)?.replace([provider]);
		}
	}, {
		async get(provider, force) {
			await loadModelDefaults();
			const adapter = adapters.get(provider);
			if (!adapter) throw new BadRequest(`provider ${provider} is not configured`);
			if (force) {
				if (provider === "codex") { codexVersion.invalidate(); await codexAdapter.refreshModels(provider); }
				else adapter.clearAccountCatalog();
				poolAdapter?.invalidate();
				handles.get(provider)?.replace([provider]);
			}
			const models = await fullCatalogs.get(provider)(provider);
			const accounts = provider === "codex" ? await codexTokens.list() : [];
			const accountCatalogs = await Promise.all(accounts.map(async (account) => ({
				account: account.key,
				models: await withTimeout((signal) => adapter.listOwnModels(provider, account.key, signal), DISCOVERY_TIMEOUT_MS).catch(() => void 0)
			})));
			const tierIds = new Set((await poolAdapter?.modelsForProvider(provider).catch(() => []) ?? []).map((model) => model.id));
			const rows = await Promise.all(models.map(async (model) => {
				const contexts = [];
				if (provider === "codex" && codexAdapter) {
					for (const account of accountCatalogs) if (account.models?.some((entry) => entry.id === model.id)) {
						const limits = await codexAdapter.contextLimits(model.id, account.account).catch(() => void 0);
						if (limits) contexts.push(limits);
					}
				}
				const info = await withTimeout(() => adapter.resolveModel(provider, model.id), DISCOVERY_TIMEOUT_MS).catch(() => void 0);
				return {
					id: model.id,
					name: model.name,
					contextWindow: info?.context?.contextWindow,
					efforts: tierIds.has(model.id) ? [] : info?.reasoning?.efforts.map(({ id, name: name$1 }) => ({
						id,
						name: name$1
					})) ?? [],
					configured: defaultEffortOf(provider, model.id),
					...contexts.length ? {
						defaultContextWindow: Math.min(...contexts.map((entry) => entry.default)),
						maxContextWindow: Math.min(...contexts.map((entry) => entry.max))
					} : {}
				};
			}));
			return {
				provider,
				settings: preferences.get(provider),
				models: rows,
				...(provider === "codex" ? { accountCatalogs: await codexAdapter.accountCatalogViews(provider) } : {}),
				tools: []
			};
		},
		async set(provider, settings) {
			if (!adapters.has(provider)) throw new BadRequest(`provider ${provider} is not configured`);
			let validated;
			try {
				validated = validatePreferences(provider, settings);
			} catch (error) {
				throw new BadRequest(error instanceof Error ? error.message : String(error));
			}
			const models = await fullCatalogs.get(provider)(provider);
			const disabled = models.filter(model => Array.isArray(validated.visibleModels) && !validated.visibleModels.includes(model.id));
			await preferences.set(provider, validated);
			// Refresh native adapter catalogs while preserving existing session selections.
			const cleared = { groups: [], errors: [] };
			handles.get(provider)?.replace([provider]);
			return { cleanup: cleared };
		}
	});
	if (claudeTokens !== void 0) {
		const tokens = claudeTokens;
		const syncTimer = setInterval(() => {
			tokens.list().then((accounts) => {
				for (const { key, session } of accounts) {
					if (session.keychainBound !== true) continue;
					tokens.session(key).catch(() => {});
				}
			}, () => void 0);
		}, 5 * 6e4);
		ctx.effect(() => () => {
			clearInterval(syncTimer);
		}, "dsh-plugin-subscriptions: claude background sync timer");
	}
	// Auxiliary generation/search tools are not registered by this provider package.
}

//#endregion
export { Config, DEFAULT_STREAM_IDLE_TIMEOUT_MS, POOL_USAGE_TIMEOUT_MS, PoolUsageTracker, SubscriptionsAuthController, ProviderSettingsStore, getProviderSettingsStore, apply, inject, name, withTimeout };

