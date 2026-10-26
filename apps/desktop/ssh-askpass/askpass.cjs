const { connect } = require("node:net");
const endpoint = process.env.OMP_SSH_ASKPASS_ENDPOINT;
const ticket = process.env.OMP_SSH_ASKPASS_TICKET;
const prompt = process.argv[2];
if (!endpoint || !ticket || !prompt || process.env.SSH_ASKPASS_PROMPT === "confirm") process.exit(1);
const socket = connect(endpoint);
let response = Buffer.alloc(0);
let answered = false;
const timer = setTimeout(() => { response.fill(0); socket.destroy(); process.exitCode = 1; }, 5000);
socket.on("connect", () => socket.write(`${ticket}\n${Buffer.from(prompt).toString("base64")}\n`));
socket.on("data", chunk => {
  if (response.length + chunk.length > 4097) { response.fill(0); chunk.fill(0); socket.destroy(); process.exitCode = 1; return; }
  const combined = Buffer.concat([response, chunk]);
  response.fill(0);
  chunk.fill(0);
  response = combined;
});
socket.on("end", () => {
  if (response.length < 2 || response[0] !== 1) { response.fill(0); process.exitCode = 1; return; }
  answered = true;
  process.stdout.write(response.subarray(1), () => { response.fill(0); process.stdout.write("\n"); });
});
socket.on("error", () => { response.fill(0); process.exitCode = 1; });
socket.on("close", () => { clearTimeout(timer); if (!answered) { response.fill(0); process.exitCode = 1; } });
