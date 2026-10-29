// prints the results of the given lookups (JSON on stdin) using chat/tools.js
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [tools, data] = process.argv.slice(2);
const { runTool } = await import(pathToFileURL(tools).href);
const D = JSON.parse(readFileSync(data, "utf8"));
const calls = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(calls.map((c) => runTool(D, c.name, c.args))));
