#!/usr/bin/env node
// Sustained terminal output for the app-lab resource workload.
//
// Writes complete lines at a fixed rate for a fixed time, through the real PTY, so the terminal
// parser, scrollback and renderer see continuous work (a "streaming terminal"). It exits by
// itself: no shell job control assumptions, no signal needed.
//
//   stream-sim.mjs [--rate 400] [--seconds 30] [--chars 96] [--seed 1]
//
// The line content is deterministic for a seed, so two runs of the same build produce the same
// byte stream and a memory difference is not a content difference.

const options = { rate: 400, seconds: 30, chars: 96, seed: 7 };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  if (!(key in options) || process.argv[index + 1] === undefined) {
    console.error(`unknown or incomplete option ${process.argv[index]}`);
    process.exit(2);
  }
  options[key] = Number(process.argv[index + 1]);
}

const rate = Math.max(1, Math.min(5000, options.rate));
const seconds = Math.max(0.2, options.seconds);
const words = (
  "streaming rows through the terminal parser while scrollback grows and the renderer keeps " +
  "presenting damaged lines under a fixed budget of memory and wakeups"
).split(" ");
let seed = (options.seed * 2654435761) >>> 0;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const initials = (text, width) => text.slice(0, width);

let line = 0;
let stopped = false;
const started = performance.now();
function write() {
  if (stopped) return;
  const elapsed = ((performance.now() - started) / 1000).toFixed(3).padStart(8);
  const tokens = [];
  let width = 0;
  while (width < options.chars) {
    const word = words[Math.floor(random() * words.length)];
    tokens.push(word);
    width += word.length + 1;
  }
  process.stdout.write(
    `${String(line).padStart(6)} ${elapsed}s ${initials(tokens.join(" "), options.chars)}\r\n`,
  );
  line++;
  if (performance.now() - started >= seconds * 1000) {
    stopped = true;
    process.exit(0);
  }
  setTimeout(write, Math.max(0, 1000 / rate - 1));
}
write();
