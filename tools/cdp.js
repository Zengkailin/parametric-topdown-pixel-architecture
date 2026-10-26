/**
 * 极简 CDP 客户端（无第三方依赖）：启动 Chrome headless，连 DevTools 协议。
 * 仅供本项目的 UI 自动化自测使用。
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME_CANDIDATES = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

function findChrome() {
	for (const candidate of CHROME_CANDIDATES) {
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error("找不到 Chrome / Edge");
}

function httpJson(port, method, urlPath) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: urlPath, method }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => {
				try { resolve(JSON.parse(body)); }
				catch (err) { reject(new Error("CDP 响应不是 JSON: " + body.slice(0, 200))); }
			});
		});
		req.on("error", reject);
		req.end();
	});
}

class WS {
	constructor(url) {
		this.url = url;
		this.id = 0;
		this.pending = new Map();
		this.handlers = new Map();
		this.buffer = Buffer.alloc(0);
		this.handshaken = false;
	}

	connect() {
		const parsed = new URL(this.url);
		return new Promise((resolve, reject) => {
			this.socket = net.connect(Number(parsed.port), parsed.hostname, () => {
				const key = crypto.randomBytes(16).toString("base64");
				const lines = [
					`GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
					`Host: ${parsed.hostname}:${parsed.port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Key: ${key}`,
					"Sec-WebSocket-Version: 13",
					"", ""
				];
				this.socket.write(lines.join("\r\n"));
			});
			this.socket.on("data", (chunk) => {
				if (!this.handshaken) {
					this.buffer = Buffer.concat([this.buffer, chunk]);
					const index = this.buffer.indexOf("\r\n\r\n");
					if (index < 0) return;
					const head = this.buffer.subarray(0, index).toString("utf8");
					if (!/^HTTP\/1\.1 101/.test(head)) {
						reject(new Error("WebSocket 握手失败：" + head.split("\r\n")[0]));
						return;
					}
					this.handshaken = true;
					this.buffer = this.buffer.subarray(index + 4);
					resolve();
					this.pump();
				} else {
					this.buffer = Buffer.concat([this.buffer, chunk]);
					this.pump();
				}
			});
			this.socket.on("error", reject);
		});
	}

	pump() {
		while (this.buffer.length >= 2) {
			const first = this.buffer[0], second = this.buffer[1];
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			const maskOffset = masked ? 4 : 0;
			if (this.buffer.length < offset + maskOffset + length) return;
			let payload = this.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
			if (masked) {
				const mask = this.buffer.subarray(offset, offset + 4);
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			}
			this.buffer = this.buffer.subarray(offset + maskOffset + length);
			if (opcode === 0x1) this.onMessage(payload.toString("utf8"));
			else if (opcode === 0x9) this.writeFrame(0xA, payload);
			else if (opcode === 0x8) { this.socket.end(); return; }
		}
	}

	onMessage(text) {
		let message;
		try { message = JSON.parse(text); } catch (err) { return; }
		if (message.id !== undefined) {
			const item = this.pending.get(message.id);
			if (!item) return;
			this.pending.delete(message.id);
			if (message.error) item.reject(new Error(message.error.message));
			else item.resolve(message.result);
			return;
		}
		const list = this.handlers.get(message.method);
		if (list) list.forEach((cb) => cb(message.params, message.sessionId));
	}

	writeFrame(opcode, payload) {
		const mask = crypto.randomBytes(4);
		const length = payload.length;
		let header;
		if (length < 126) {
			header = Buffer.alloc(6);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | length;
			mask.copy(header, 2);
		} else if (length < 65536) {
			header = Buffer.alloc(8);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(length, 2);
			mask.copy(header, 4);
		} else {
			header = Buffer.alloc(14);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(length), 2);
			mask.copy(header, 10);
		}
		const body = Buffer.from(payload);
		for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
		this.socket.write(Buffer.concat([header, body]));
	}

	send(method, params, sessionId) {
		const id = ++this.id;
		const message = { id, method, params: params || {} };
		if (sessionId) message.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.writeFrame(0x1, Buffer.from(JSON.stringify(message)));
		});
	}

	on(method, cb) {
		if (!this.handlers.has(method)) this.handlers.set(method, []);
		this.handlers.get(method).push(cb);
	}
}

class Browser {
	constructor(options) {
		this.options = options || {};
		this.port = this.options.port || 9223;
		this.logs = [];
		this.errors = [];
	}

	async launch(url) {
		this.profile = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cdp-"));
		const args = [
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=Translate,BackForwardCache",
			"--window-size=" + (this.options.width || 1600) + "," + (this.options.height || 1000),
			"--remote-debugging-port=" + this.port,
			"--user-data-dir=" + this.profile,
			"--allow-file-access-from-files",
			url
		];
		this.proc = spawn(findChrome(), args, { stdio: "ignore" });
		const deadline = Date.now() + 15000;
		let targets = null;
		while (Date.now() < deadline) {
			try {
				targets = await httpJson(this.port, "GET", "/json/list");
				if (targets && targets.length) break;
			} catch (err) { /* 还没起来 */ }
			await new Promise((r) => setTimeout(r, 200));
		}
		if (!targets || !targets.length) throw new Error("Chrome 调试端口没有响应");
		const page = targets.find((t) => t.type === "page") || targets[0];
		this.ws = new WS(page.webSocketDebuggerUrl);
		await this.ws.connect();
		await this.ws.send("Runtime.enable");
		await this.ws.send("Page.enable");
		await this.ws.send("Log.enable");
		await this.ws.send("Console.enable");
		this.ws.on("Runtime.consoleAPICalled", (params) => {
			const text = (params.args || []).map((arg) => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type)).join(" ");
			this.logs.push({ type: params.type, text });
			if (params.type === "error") this.errors.push(text);
		});
		this.ws.on("Runtime.exceptionThrown", (params) => {
			const detail = params.exceptionDetails || {};
			const text = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || "unknown error";
			this.errors.push(text);
			this.logs.push({ type: "exception", text });
		});
		this.ws.on("Log.entryAdded", (params) => {
			const entry = params.entry || {};
			this.logs.push({ type: entry.level, text: entry.text });
			if (entry.level === "error") this.errors.push(entry.text);
		});
		return this;
	}

	async eval(expression, awaitPromise) {
		const result = await this.ws.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: !!awaitPromise,
			userGesture: true
		});
		if (result.exceptionDetails) {
			const detail = result.exceptionDetails;
			throw new Error((detail.exception && detail.exception.description) || detail.text || "eval 失败");
		}
		return result.result ? result.result.value : undefined;
	}

	async waitFor(expression, timeout) {
		const deadline = Date.now() + (timeout || 20000);
		while (Date.now() < deadline) {
			try {
				if (await this.eval(expression)) return true;
			} catch (err) { /* 页面可能还没就绪 */ }
			await new Promise((r) => setTimeout(r, 150));
		}
		throw new Error("等待超时：" + expression);
	}

	async screenshot(file) {
		const result = await this.ws.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		fs.writeFileSync(file, Buffer.from(result.data, "base64"));
		return file;
	}

	async setDownloadDir(dir) {
		await this.ws.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: false });
	}

	async close() {
		try { await this.ws.send("Browser.close"); } catch (err) { /* ignore */ }
		try { this.proc.kill(); } catch (err) { /* ignore */ }
		await new Promise((r) => setTimeout(r, 400));
	}
}

module.exports = { Browser, findChrome };
