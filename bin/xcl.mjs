#!/usr/bin/env node
import { main } from "../src/cli.js";

// Piping into `head` (or any short-lived consumer) must not look like a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error && error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    const message = error && error.stack ? error.stack : String(error);
    process.stderr.write(`xcl: ${message}\n`);
    process.exitCode = 1;
  });
