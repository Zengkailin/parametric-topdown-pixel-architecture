"use strict";
/**
 * JSON 读入：容忍 Windows 下 PowerShell 写入的 UTF-8 BOM，
 * 并把解析错误换成「哪个文件、第几处」这种可读信息。
 */
const fs = require("fs");

function stripBom(text) {
	const str = String(text);
	return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

function parse(text, label) {
	const head = label ? label + "：" : "";
	const body = stripBom(String(text)).trim();
	if (!/^[{[]/.test(body)) {
		const hint = body.slice(0, 16).replace(/[\r\n\t]/g, " ");
		throw new Error(head + "这不是 JSON 内容（开头是「" + hint + "…」），检查是否传错了文件");
	}
	try {
		return JSON.parse(body);
	} catch (err) {
		throw new Error(head + "JSON 解析失败（" + err.message + "）");
	}
}

function read(file, label) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		throw new Error("读不到文件：" + file);
	}
	return parse(text, label || file);
}

module.exports = { stripBom, parse, read };
