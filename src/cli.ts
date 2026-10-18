import { main } from "./main";

// `wf ... | head` closes stdout early. That is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

main(process.argv).then((code) => {
  process.exitCode = code;
});
