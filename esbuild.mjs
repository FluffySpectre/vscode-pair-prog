import * as esbuild from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const wsCjsPlugin = {
	name: "ws-cjs",
	setup(build) {
		build.onResolve({ filter: /^ws$/ }, () => ({
			path: require.resolve("ws"),
			sideEffects: false,
		}));
	},
};

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "out/extension.js",
	external: ["vscode"],
	format: "cjs",
	platform: "node",
	target: "ES2022",
	sourcemap: !production,
	minify: production,
	plugins: [wsCjsPlugin],
};

async function main() {
	if (watch) {
		const ctx = await esbuild.context(buildOptions);
		await ctx.watch();
		console.log("Watching for changes...");
	} else {
		await esbuild.build(buildOptions);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
