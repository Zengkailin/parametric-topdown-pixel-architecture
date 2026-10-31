"use strict";
/**
 * 把浏览器端的 js/ 模块装进 Node 的 globalThis.TB。
 *
 * 这些模块是 IIFE + 全局命名空间的写法，require 一次即可；
 * 顺序与网页 index.html 的 <script> 顺序一致。atlases.js（约 7.6MB）
 * 故意不在核心加载里：`list`/`schema`/`styles` 等命令完全用不到图集。
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const JS = path.join(ROOT, "js");

let coreLoaded = false;
let atlasLoaded = false;

function loadCore() {
	if (!coreLoaded) {
		["util", "catalog", "materials", "geometry", "view", "renderer", "godot"].forEach(function (name) {
			require(path.join(JS, name + ".js"));
		});
		coreLoaded = true;
	}
	return globalThis.TB;
}

function loadAtlases() {
	loadCore();
	if (!atlasLoaded) {
		require(path.join(JS, "atlases.js"));
		atlasLoaded = true;
	}
	return globalThis.TB;
}

function atlasesFingerprint() {
	const stat = fs.statSync(path.join(JS, "atlases.js"));
	return stat.size + ":" + Math.round(stat.mtimeMs);
}

module.exports = { ROOT, JS, loadCore, loadAtlases, atlasesFingerprint };
