import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/prompts", import.meta.url));
const destination = fileURLToPath(new URL("../dist/prompts", import.meta.url));

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
