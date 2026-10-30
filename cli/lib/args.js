"use strict";
/**
 * 极简命令行解析器（零依赖）。
 *
 * 支持：
 *   --key value / --key=value / -k value / --flag / --no-flag
 *   可重复项（如 --param、--part）收集为数组
 *   可选数值项（如 --thumb 96 或 --thumb）
 *   负数取值（--yaw -90）不会被当成选项
 */

const NUMERIC_LIKE = /^-\d/;

function looksLikeValue(token) {
	if (token === undefined) return false;
	if (token === "-") return true;
	if (token.charAt(0) !== "-") return true;
	return NUMERIC_LIKE.test(token);
}

function parse(argv, options) {
	options = options || {};
	const booleans = new Set(options.booleans || []);
	const repeat = new Set(options.repeat || []);
	const optional = new Set(options.optional || []);
	const aliases = options.aliases || {};
	const out = { _: [] };
	const given = new Set();

	function assign(key, value) {
		if (repeat.has(key)) {
			if (!Array.isArray(out[key])) out[key] = [];
			out[key].push(value);
		} else {
			out[key] = value;
		}
		given.add(key);
	}

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--") {
			for (let j = i + 1; j < argv.length; j++) out._.push(argv[j]);
			break;
		}
		let key = null, value = null;
		if (token.startsWith("--")) {
			key = token.slice(2);
			const eq = key.indexOf("=");
			if (eq >= 0) {
				value = key.slice(eq + 1);
				key = key.slice(0, eq);
			}
			if (key.startsWith("no-")) {
				assign(key.slice(3), false);
				continue;
			}
		} else if (token.length === 2 && token.charAt(0) === "-") {
			const short = token.charAt(1);
			key = aliases[short] || short;
			if (!key) throw new Error("未知短选项：" + token);
		} else {
			out._.push(token);
			continue;
		}
		if (aliases[key]) key = aliases[key];
		if (value !== null) {
			assign(key, value);
			continue;
		}
		if (booleans.has(key)) {
			const next = argv[i + 1];
			if (next === "true" || next === "false") {
				assign(key, next === "true");
				i++;
			} else {
				assign(key, true);
			}
			continue;
		}
		const next = argv[i + 1];
		if (looksLikeValue(next)) {
			assign(key, next);
			i++;
		} else if (optional.has(key)) {
			assign(key, true);
		} else {
			assign(key, "true");
		}
	}
	out.__given = given;
	return out;
}

/** 该选项是否被显式给出（区分「没写」和「写了默认值」）。 */
function given(args, key) {
	return args.__given ? args.__given.has(key) : args[key] !== undefined;
}

/** 把 ["k=v", "a=b"] 解析成对象。 */
function pairs(list) {
	const out = {};
	(list || []).forEach(function (entry) {
		const index = String(entry).indexOf("=");
		if (index < 0) throw new Error("需要 key=value 形式，收到：" + entry);
		out[String(entry).slice(0, index)] = String(entry).slice(index + 1);
	});
	return out;
}

module.exports = { parse, given, pairs };
