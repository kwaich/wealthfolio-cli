import { main } from "./main";

main(process.argv).then((code) => {
  process.exitCode = code;
});
